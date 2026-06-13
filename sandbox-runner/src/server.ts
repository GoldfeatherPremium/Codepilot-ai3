import express, { type Request, type Response, type NextFunction } from "express";
import { pinoHttp } from "pino-http";
import { z } from "zod";
import { config } from "./config.js";
import { logger, requireAuth, rateLimit } from "./middleware.js";
import { sessionCount, listSessionsInfo } from "./sessions.js";
import {
  createSandbox, cloneRepository, executeCommand, readFile, writeFile, editFile,
  deleteFile, listFiles, generateDiff, commitChanges, pushBranch, destroySandbox,
  snapshotWorkspace, listSnapshots, rollbackSnapshot, diffSnapshots, sandboxStats,
} from "./sandbox.js";
import { execQueue, addExecJob, runJobAndWait, retryJob, queueStats, getLogBacklog, subscribeLogs } from "./queue.js";
import { docker } from "./docker.js";

const startedAt = Date.now();

const clampTimeout = (t?: number) =>
  Math.min(Math.max(t ?? config.DEFAULT_TIMEOUT_SECONDS, 1), config.MAX_TIMEOUT_SECONDS);

// --- request schemas ---------------------------------------------------------

const RepoName = z.string().regex(/^[\w.-]+\/[\w.-]+$/);

const ExecBody = z.object({
  repo: RepoName.nullish(),
  branch: z.string().max(255).nullish(),
  command: z.string().min(1).max(10_000),
  timeout_seconds: z.coerce.number().optional(),
  staged_files: z.record(z.string()).optional(),
  github_token: z.string().nullish(),
  env: z.record(z.string()).optional(),
  job_key: z.string().max(120).optional(),
});

const SandboxBody = z.object({
  repo: RepoName.nullish(),
  branch: z.string().max(255).nullish(),
  github_token: z.string().nullish(),
  staged_files: z.record(z.string()).optional(),
});

const SandboxExecBody = z.object({
  command: z.string().min(1).max(10_000),
  timeout_seconds: z.coerce.number().optional(),
  env: z.record(z.string()).optional(),
  async: z.boolean().optional(),
  job_key: z.string().max(120).optional(),
});

const CloneBody = z.object({
  repo: RepoName,
  branch: z.string().max(255).nullish(),
  github_token: z.string().min(20),
});

const WriteFileBody = z.object({ path: z.string().min(1).max(512), content: z.string().max(2_000_000) });
const EditFileBody = z.object({
  path: z.string().min(1).max(512),
  old_str: z.string().min(1).max(200_000),
  new_str: z.string().max(200_000).default(""),
  replace_all: z.boolean().optional(),
});
const CommitBody = z.object({
  message: z.string().min(1).max(5_000),
  author_name: z.string().max(200).default("CodePilot Agent"),
  author_email: z.string().max(200).default("agent@codepilot.ai"),
});
const PushBody = z.object({ branch: z.string().min(1).max(255), github_token: z.string().nullish() });
const SnapshotBody = z.object({ label: z.string().max(200).optional() });
const RollbackBody = z.object({ snapshot_id: z.string().regex(/^[0-9a-f]{7,40}$/i) });

// --- helpers -------------------------------------------------------------------

function execResultJson(r: { exitCode: number; stdout: string; stderr: string; timedOut: boolean; durationMs: number }, sandboxId: string) {
  return {
    exit_code: r.exitCode, stdout: r.stdout, stderr: r.stderr,
    sandbox_id: sandboxId, timed_out: r.timedOut, duration_ms: r.durationMs,
  };
}

export function buildServer(): express.Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "20mb" }));
  app.use(pinoHttp({
    logger,
    redact: ["req.headers.authorization", "req.body.github_token"],
    autoLogging: { ignore: (req) => req.url === "/healthz" },
  }));

  // ---- health & monitoring (healthz unauthenticated for load balancers) -----
  app.get("/healthz", async (_req, res) => {
    try {
      await docker.ping();
      res.json({ ok: true, sessions: sessionCount(), uptime_seconds: Math.floor((Date.now() - startedAt) / 1000) });
    } catch {
      res.status(503).json({ ok: false, error: "docker unreachable" });
    }
  });

  // Everything below requires the bearer token + rate limit.
  app.use(requireAuth, rateLimit);

  // Backwards-compatible alias: pre-1.0 clients used /sessions/* paths.
  app.use((req, _res, next) => {
    if (req.url === "/sessions" || req.url.startsWith("/sessions/")) {
      req.url = "/sandboxes" + req.url.slice("/sessions".length);
    }
    next();
  });

  app.get("/metrics", async (_req, res, next) => {
    try {
      const [queue, info, sessions] = await Promise.all([
        queueStats(),
        docker.info().catch(() => null),
        Promise.all(listSessionsInfo().map(async (s) => ({ ...s, stats: await sandboxStats(s.id).catch(() => null) }))),
      ]);
      res.json({
        ok: true,
        uptime_seconds: Math.floor((Date.now() - startedAt) / 1000),
        queue,
        sessions: { count: sessions.length, max: config.MAX_SESSIONS, detail: sessions },
        limits: {
          cpus: config.SANDBOX_CPUS, memory_mb: config.SANDBOX_MEMORY_MB,
          disk_mb: config.SANDBOX_DISK_MB, pids: config.SANDBOX_PIDS_LIMIT,
          max_concurrent_jobs: config.MAX_CONCURRENT_JOBS,
        },
        docker: info ? { containers_running: info.ContainersRunning, images: info.Images, mem_total: info.MemTotal, ncpu: info.NCPU } : null,
      });
    } catch (e) { next(e); }
  });

  // ---- one-shot exec — the endpoint agent-run's execute_command falls back to.
  app.post("/exec", async (req, res, next) => {
    try {
      const body = ExecBody.parse(req.body);
      const result = await runJobAndWait({
        mode: "oneshot",
        jobKey: body.job_key,
        repo: body.repo ?? null,
        branch: body.branch ?? null,
        githubToken: body.github_token ?? null,
        stagedFiles: body.staged_files,
        command: body.command,
        timeoutSeconds: clampTimeout(body.timeout_seconds),
        env: body.env,
      });
      res.json(execResultJson(result, result.sandboxId));
    } catch (e) { next(e); }
  });

  // ---- sandbox lifecycle -------------------------------------------------------
  app.post("/sandboxes", async (req, res, next) => {
    try {
      const body = SandboxBody.parse(req.body);
      const { sandboxId } = await createSandbox({
        repo: body.repo ?? null, branch: body.branch ?? null,
        githubToken: body.github_token ?? null, stagedFiles: body.staged_files,
      });
      res.status(201).json({ sandbox_id: sandboxId });
    } catch (e) { next(e); }
  });

  app.post("/sandboxes/:id/clone", async (req, res, next) => {
    try {
      const body = CloneBody.parse(req.body);
      await cloneRepository(req.params.id, body.repo, body.branch ?? null, body.github_token);
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  app.delete("/sandboxes/:id", async (req, res, next) => {
    try { await destroySandbox(req.params.id); res.json({ ok: true }); } catch (e) { next(e); }
  });

  // ---- execution (queued; sync by default, async + SSE on request) ------------
  app.post("/sandboxes/:id/exec", async (req, res, next) => {
    try {
      const body = SandboxExecBody.parse(req.body);
      const data = {
        mode: "session" as const,
        sessionId: req.params.id,
        jobKey: body.job_key,
        command: body.command,
        timeoutSeconds: clampTimeout(body.timeout_seconds),
        env: body.env,
      };
      if (body.async) {
        const job = await addExecJob(data);
        res.status(202).json({ job_id: job.id, stream_url: `/sandboxes/${req.params.id}/exec/${job.id}/stream` });
        return;
      }
      const result = await runJobAndWait(data);
      res.json(execResultJson(result, result.sandboxId));
    } catch (e) { next(e); }
  });

  // ---- real-time log streaming (Server-Sent Events) -----------------------------
  app.get("/sandboxes/:id/exec/:jobId/stream", async (req, res) => {
    const { jobId } = req.params;
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    const send = (event: string, payload: string) => res.write(`event: ${event}\ndata: ${payload}\n\n`);

    for (const chunk of await getLogBacklog(jobId)) send("log", chunk);

    const unsubscribe = subscribeLogs(jobId, (msg) => send("log", msg));
    const keepalive = setInterval(() => res.write(": ping\n\n"), 15_000);
    const poll = setInterval(async () => {
      const job = await execQueue.getJob(jobId);
      const state = job ? await job.getState() : "missing";
      if (state === "completed" || state === "failed" || state === "missing") {
        send("done", JSON.stringify({ state, result: job?.returnvalue ?? null, error: job?.failedReason ?? null }));
        cleanup();
      }
    }, 1_000);
    const cleanup = () => { clearInterval(keepalive); clearInterval(poll); unsubscribe(); res.end(); };
    req.on("close", cleanup);
  });

  app.post("/jobs/:jobId/retry", async (req, res, next) => {
    try { res.json(await retryJob(req.params.jobId)); } catch (e) { next(e); }
  });

  // ---- file engine ----------------------------------------------------------------
  app.get("/sandboxes/:id/files", async (req, res, next) => {
    try {
      const path = String(req.query.path ?? "");
      if (path) { res.json(await readFile(req.params.id, path)); return; }
      res.json({ files: await listFiles(req.params.id, String(req.query.prefix ?? "") || undefined) });
    } catch (e) { next(e); }
  });

  app.put("/sandboxes/:id/files", async (req, res, next) => {
    try {
      const body = WriteFileBody.parse(req.body);
      res.json(await writeFile(req.params.id, body.path, body.content));
    } catch (e) { next(e); }
  });

  app.patch("/sandboxes/:id/files", async (req, res, next) => {
    try {
      const body = EditFileBody.parse(req.body);
      res.json(await editFile(req.params.id, body.path, body.old_str, body.new_str, body.replace_all ?? false));
    } catch (e) { next(e); }
  });

  app.delete("/sandboxes/:id/files", async (req, res, next) => {
    try {
      const path = String(req.query.path ?? "");
      if (!path) { res.status(400).json({ error: "path query param required" }); return; }
      await deleteFile(req.params.id, path);
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  // ---- diff / commit / push ----------------------------------------------------------
  app.get("/sandboxes/:id/diff", async (req, res, next) => {
    try { res.json(await generateDiff(req.params.id)); } catch (e) { next(e); }
  });

  app.post("/sandboxes/:id/commit", async (req, res, next) => {
    try {
      const body = CommitBody.parse(req.body);
      const out = await commitChanges(req.params.id, body.message, { name: body.author_name, email: body.author_email });
      res.json({ sha: out.sha, files_changed: out.filesChanged, additions: out.additions, deletions: out.deletions });
    } catch (e) { next(e); }
  });

  app.post("/sandboxes/:id/push", async (req, res, next) => {
    try {
      const body = PushBody.parse(req.body);
      await pushBranch(req.params.id, body.branch, body.github_token ?? undefined);
      res.json({ ok: true, branch: body.branch });
    } catch (e) { next(e); }
  });

  // ---- snapshots --------------------------------------------------------------------
  app.post("/sandboxes/:id/snapshots", async (req, res, next) => {
    try {
      const body = SnapshotBody.parse(req.body ?? {});
      res.status(201).json(await snapshotWorkspace(req.params.id, body.label));
    } catch (e) { next(e); }
  });

  app.get("/sandboxes/:id/snapshots", async (req, res, next) => {
    try { res.json({ snapshots: listSnapshots(req.params.id) }); } catch (e) { next(e); }
  });

  app.post("/sandboxes/:id/snapshots/rollback", async (req, res, next) => {
    try {
      const body = RollbackBody.parse(req.body);
      await rollbackSnapshot(req.params.id, body.snapshot_id);
      res.json({ ok: true, restored: body.snapshot_id });
    } catch (e) { next(e); }
  });

  app.get("/sandboxes/:id/snapshots/compare", async (req, res, next) => {
    try {
      const from = String(req.query.from ?? "");
      const to = String(req.query.to ?? "worktree");
      if (!from) { res.status(400).json({ error: "from query param required" }); return; }
      res.json(await diffSnapshots(req.params.id, from, to === "worktree" ? "worktree" : to));
    } catch (e) { next(e); }
  });

  // ---- errors -------------------------------------------------------------------------
  app.use((err: Error & { status?: number }, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: "Invalid request", details: err.issues });
      return;
    }
    logger.error({ err }, "request failed");
    res.status(err.status ?? 500).json({ error: err.message ?? "Internal error" });
  });

  return app;
}
