import { z } from "zod";

const Env = z.object({
  PORT: z.coerce.number().default(8080),
  SANDBOX_RUNNER_TOKEN: z.string().min(24, "SANDBOX_RUNNER_TOKEN must be at least 24 chars"),

  REDIS_URL: z.string().default("redis://127.0.0.1:6379"),
  DOCKER_SOCKET: z.string().default("/var/run/docker.sock"),

  // Sandbox image (built from ./sandbox-image)
  SANDBOX_IMAGE: z.string().default("codepilot-sandbox:latest"),

  // Resource limits per container
  SANDBOX_CPUS: z.coerce.number().default(1),            // CPU cores
  SANDBOX_MEMORY_MB: z.coerce.number().default(1024),    // RAM, swap disabled
  SANDBOX_PIDS_LIMIT: z.coerce.number().default(256),
  SANDBOX_DISK_MB: z.coerce.number().default(2048),      // overlay quota (needs xfs+pquota) — see README
  SANDBOX_TMPFS_MB: z.coerce.number().default(256),      // /tmp size

  // Networking inside sandboxes: needed for git clone + package installs.
  // "bridge" = full egress, "none" = no network (staged_files-only workflows).
  SANDBOX_NETWORK: z.enum(["bridge", "none"]).default("bridge"),

  // Job execution
  MAX_CONCURRENT_JOBS: z.coerce.number().default(4),
  DEFAULT_TIMEOUT_SECONDS: z.coerce.number().default(120),
  MAX_TIMEOUT_SECONDS: z.coerce.number().default(600),
  MAX_OUTPUT_BYTES: z.coerce.number().default(1_000_000), // per stream, then truncated

  // Queue retry policy for infrastructure failures (docker hiccups etc.).
  // User commands are NOT silently re-run: attempts apply to job-level errors,
  // and a command that ran to completion (any exit code) counts as success.
  JOB_ATTEMPTS: z.coerce.number().default(2),
  JOB_BACKOFF_MS: z.coerce.number().default(3000),

  // Sessions
  SESSION_TTL_SECONDS: z.coerce.number().default(900),    // idle sessions destroyed after 15 min
  MAX_SESSIONS: z.coerce.number().default(20),

  // Rate limiting (sliding window, Redis-backed)
  RATE_LIMIT_PER_MINUTE: z.coerce.number().default(60),

  LOG_LEVEL: z.string().default("info"),
});

export const config = Env.parse(process.env);
export type Config = typeof config;
