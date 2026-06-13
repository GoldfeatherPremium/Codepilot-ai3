import Docker from "dockerode";
import { PassThrough } from "node:stream";
import { config } from "./config.js";
import { logger, redactSecrets } from "./middleware.js";

export const docker = new Docker({ socketPath: config.DOCKER_SOCKET });

const LABEL = "codepilot.sandbox";

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Container creation — every limit the kernel gives us:
// CPU (NanoCpus), RAM (Memory == MemorySwap, so no swap escape), process count
// (PidsLimit), disk (StorageOpt overlay quota where supported + tmpfs cap),
// dropped capabilities, no privilege escalation, default seccomp, non-root user.
// ---------------------------------------------------------------------------
export async function createSandboxContainer(sandboxId: string): Promise<Docker.Container> {
  const memoryBytes = config.SANDBOX_MEMORY_MB * 1024 * 1024;

  const container = await docker.createContainer({
    Image: config.SANDBOX_IMAGE,
    name: `cp-sbx-${sandboxId}`,
    Labels: { [LABEL]: "1", "codepilot.sandbox.id": sandboxId },
    User: "sandbox",
    WorkingDir: "/workspace",
    Entrypoint: ["sleep"],
    Cmd: ["infinity"], // keep alive; we drive it with exec
    Env: ["HOME=/home/sandbox", "GOPATH=/home/sandbox/go", "CARGO_HOME=/home/sandbox/.cargo"],
    HostConfig: {
      Init: true, // tini as pid 1 reaps zombies and forwards signals
      NanoCpus: Math.round(config.SANDBOX_CPUS * 1e9),
      Memory: memoryBytes,
      MemorySwap: memoryBytes, // == Memory → swap disabled
      PidsLimit: config.SANDBOX_PIDS_LIMIT,
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges:true"],
      NetworkMode: config.SANDBOX_NETWORK,
      ReadonlyRootfs: false, // /workspace and $HOME must be writable
      Tmpfs: { "/tmp": `rw,noexec,nosuid,size=${config.SANDBOX_TMPFS_MB}m` },
      // Disk quota for the writable layer. Requires overlay2 on xfs with
      // pquota (see README §3). Docker rejects it otherwise, so we retry
      // without it below rather than failing the whole job.
      StorageOpt: { size: `${config.SANDBOX_DISK_MB}M` },
      Ulimits: [{ Name: "nofile", Soft: 4096, Hard: 4096 }],
      AutoRemove: false, // we remove explicitly so we can collect diffs first
    },
  }).catch(async (err: Error) => {
    if (/storage-opt|quota|--storage-opt/i.test(err.message)) {
      logger.warn("StorageOpt unsupported by storage driver — creating without disk quota (see README §3)");
      return docker.createContainer({
        Image: config.SANDBOX_IMAGE,
        name: `cp-sbx-${sandboxId}`,
        Labels: { [LABEL]: "1", "codepilot.sandbox.id": sandboxId },
        User: "sandbox",
        WorkingDir: "/workspace",
        Entrypoint: ["sleep"],
        Cmd: ["infinity"],
        Env: ["HOME=/home/sandbox", "GOPATH=/home/sandbox/go", "CARGO_HOME=/home/sandbox/.cargo"],
        HostConfig: {
          Init: true,
          NanoCpus: Math.round(config.SANDBOX_CPUS * 1e9),
          Memory: memoryBytes,
          MemorySwap: memoryBytes,
          PidsLimit: config.SANDBOX_PIDS_LIMIT,
          CapDrop: ["ALL"],
          SecurityOpt: ["no-new-privileges:true"],
          NetworkMode: config.SANDBOX_NETWORK,
          Tmpfs: { "/tmp": `rw,noexec,nosuid,size=${config.SANDBOX_TMPFS_MB}m` },
          Ulimits: [{ Name: "nofile", Soft: 4096, Hard: 4096 }],
        },
      });
    }
    throw err;
  });

  await container.start();
  return container;
}

// ---------------------------------------------------------------------------
// Exec — runs `bash -lc <command>` inside the container, demuxes the Docker
// multiplexed stream into stdout/stderr, enforces a wall-clock timeout (the
// process group is SIGKILLed on expiry), caps captured output, and optionally
// emits chunks to a callback for real-time streaming.
// ---------------------------------------------------------------------------
export async function execInContainer(
  container: Docker.Container,
  command: string,
  opts: {
    timeoutSeconds: number;
    env?: string[];
    workdir?: string;
    onChunk?: (stream: "stdout" | "stderr", data: string) => void;
  },
): Promise<ExecResult> {
  const started = Date.now();
  const exec = await container.exec({
    Cmd: ["/bin/bash", "-lc", command],
    AttachStdout: true,
    AttachStderr: true,
    WorkingDir: opts.workdir ?? "/workspace",
    Env: opts.env,
    User: "sandbox",
  });

  const duplex = await exec.start({ hijack: true, stdin: false });

  let stdout = "";
  let stderr = "";
  let truncated = false;
  let timedOut = false;

  const out = new PassThrough();
  const err = new PassThrough();
  docker.modem.demuxStream(duplex, out, err);

  const capture = (which: "stdout" | "stderr") => (buf: Buffer) => {
    const text = redactSecrets(buf.toString("utf8"));
    opts.onChunk?.(which, text);
    if (which === "stdout") {
      if (stdout.length < config.MAX_OUTPUT_BYTES) stdout += text;
      else truncated = true;
    } else {
      if (stderr.length < config.MAX_OUTPUT_BYTES) stderr += text;
      else truncated = true;
    }
  };
  out.on("data", capture("stdout"));
  err.on("data", capture("stderr"));

  const finished = new Promise<void>((resolve) => {
    duplex.on("end", resolve);
    duplex.on("close", resolve);
    duplex.on("error", resolve);
  });

  const timer = setTimeout(async () => {
    timedOut = true;
    try {
      // Kill the exec'd process tree; `sleep infinity` (pid 1) survives, so the
      // container/session stays usable.
      const inspect = await exec.inspect();
      if (inspect.Pid) {
        await execRaw(container, `kill -KILL -- -$(ps -o pgid= -p ${inspect.Pid} | tr -d ' ') 2>/dev/null || kill -KILL ${inspect.Pid} 2>/dev/null || true`);
      }
    } catch { /* container may already be gone */ }
    duplex.destroy();
  }, opts.timeoutSeconds * 1000);

  await finished;
  clearTimeout(timer);

  let exitCode = 137;
  try {
    const info = await exec.inspect();
    exitCode = info.ExitCode ?? (timedOut ? 124 : 1);
  } catch { /* keep default */ }
  if (timedOut) exitCode = 124;

  if (truncated) stderr += "\n[output truncated by sandbox runner]";

  return {
    exitCode,
    stdout: stdout.slice(0, config.MAX_OUTPUT_BYTES),
    stderr: stderr.slice(0, config.MAX_OUTPUT_BYTES),
    timedOut,
    durationMs: Date.now() - started,
  };
}

/** Internal plumbing exec (timeout kills). Runs as the sandbox user: with all
 *  capabilities dropped even root lacks CAP_KILL, but same-uid signaling is
 *  always permitted. */
async function execRaw(container: Docker.Container, command: string): Promise<void> {
  const exec = await container.exec({
    Cmd: ["/bin/sh", "-c", command],
    AttachStdout: false,
    AttachStderr: false,
    User: "sandbox",
  });
  await exec.start({ detach: true });
}

export async function destroyContainer(container: Docker.Container): Promise<void> {
  try { await container.remove({ force: true, v: true }); }
  catch (e) { logger.warn({ err: e }, "container removal failed (may already be gone)"); }
}

/** On boot, sweep any sandbox containers a previous process left behind. */
export async function sweepOrphans(): Promise<void> {
  const list = await docker.listContainers({ all: true, filters: { label: [`${LABEL}=1`] } });
  for (const info of list) {
    logger.info({ id: info.Id.slice(0, 12) }, "removing orphaned sandbox container");
    await destroyContainer(docker.getContainer(info.Id));
  }
}
