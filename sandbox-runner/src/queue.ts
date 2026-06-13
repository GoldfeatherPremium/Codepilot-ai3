import { Queue, Worker, QueueEvents, UnrecoverableError, type Job } from "bullmq";
import { Redis } from "ioredis";
import { config } from "./config.js";
import { logger, redis } from "./middleware.js";
import { execInContainer, type ExecResult } from "./docker.js";
import { getSession, createSession, destroySession } from "./sessions.js";

const connection = { url: config.REDIS_URL };

export interface ExecJobData {
  mode: "session" | "oneshot";
  /** Idempotency key from the caller. Two enqueues with the same key while the
   *  first is pending/active return the SAME job — duplicate execution is
   *  structurally impossible. */
  jobKey?: string;
  sessionId?: string;          // session mode
  // oneshot mode — a throwaway session is created and destroyed around the command
  repo?: string | null;
  branch?: string | null;
  githubToken?: string | null;
  stagedFiles?: Record<string, string>;

  command: string;
  timeoutSeconds: number;
  env?: Record<string, string>;
}

export interface ExecJobResult extends ExecResult {
  sandboxId: string;
}

export const execQueue = new Queue<ExecJobData, ExecJobResult>("exec", { connection });
export const execEvents = new QueueEvents("exec", { connection });

// ---------------------------------------------------------------------------
// Real-time log fan-out. The worker publishes chunks to Redis pub/sub
// (`sbx:logs:{jobId}`) and appends them to a capped Redis list so SSE clients
// that connect mid-run still get the backlog. Works across processes.
// ---------------------------------------------------------------------------
function publishChunk(jobId: string, stream: "stdout" | "stderr", data: string): void {
  const payload = JSON.stringify({ stream, data, at: Date.now() });
  void redis.publish(`sbx:logs:${jobId}`, payload);
  void redis.rpush(`sbx:logbuf:${jobId}`, payload)
    .then(() => redis.ltrim(`sbx:logbuf:${jobId}`, -500, -1))
    .then(() => redis.expire(`sbx:logbuf:${jobId}`, 600));
}

export async function getLogBacklog(jobId: string): Promise<string[]> {
  return redis.lrange(`sbx:logbuf:${jobId}`, 0, -1);
}

export function subscribeLogs(jobId: string, onMessage: (payload: string) => void): () => void {
  const sub = new Redis(config.REDIS_URL);
  void sub.subscribe(`sbx:logs:${jobId}`);
  sub.on("message", (_ch, msg) => onMessage(msg));
  return () => { void sub.unsubscribe(); sub.disconnect(); };
}

// ---------------------------------------------------------------------------
// Worker — concurrency-capped; each job runs one command in one container.
// ---------------------------------------------------------------------------
export function startWorker(): Worker<ExecJobData, ExecJobResult> {
  const worker = new Worker<ExecJobData, ExecJobResult>(
    "exec",
    async (job: Job<ExecJobData, ExecJobResult>) => {
      const d = job.data;
      const env = Object.entries(d.env ?? {}).map(([k, v]) => `${k}=${v}`);
      const onChunk = (stream: "stdout" | "stderr", data: string) => publishChunk(job.id!, stream, data);

      if (d.mode === "session") {
        const session = getSession(d.sessionId!);
        // Unrecoverable: retrying cannot resurrect a destroyed/reaped sandbox.
        if (!session) throw new UnrecoverableError("Session not found or expired");
        session.busy = true;
        try {
          const result = await execInContainer(session.container, d.command, {
            timeoutSeconds: d.timeoutSeconds, env, onChunk,
          });
          return { ...result, sandboxId: session.id };
        } finally {
          session.busy = false;
          session.lastUsedAt = Date.now();
        }
      }

      // one-shot: ephemeral container, destroyed no matter what
      const session = await createSession({
        repo: d.repo, branch: d.branch, githubToken: d.githubToken, stagedFiles: d.stagedFiles,
      });
      try {
        const result = await execInContainer(session.container, d.command, {
          timeoutSeconds: d.timeoutSeconds, env, onChunk,
        });
        return { ...result, sandboxId: session.id };
      } finally {
        await destroySession(session.id);
      }
    },
    {
      connection,
      concurrency: config.MAX_CONCURRENT_JOBS,
      // Jobs that exceed timeout + setup margin are considered stalled and failed.
      lockDuration: (config.MAX_TIMEOUT_SECONDS + 360) * 1000,
    },
  );

  worker.on("failed", (job, err) => logger.warn({ jobId: job?.id, err: err.message }, "exec job failed"));
  worker.on("completed", (job) => logger.info({ jobId: job.id, ms: job.returnvalue?.durationMs }, "exec job completed"));
  return worker;
}

const JOB_OPTS = {
  removeOnComplete: { age: 3600, count: 500 },
  removeOnFail: { age: 3600, count: 500 },
  attempts: config.JOB_ATTEMPTS,
  backoff: { type: "exponential" as const, delay: config.JOB_BACKOFF_MS },
};

/** Enqueue with idempotency: an existing non-finished job with the same key is
 *  returned instead of creating a duplicate. */
export async function addExecJob(data: ExecJobData): Promise<Job<ExecJobData, ExecJobResult>> {
  if (data.jobKey) {
    const jobId = `k-${data.jobKey.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 80)}`;
    const existing = await execQueue.getJob(jobId);
    if (existing) {
      const state = await existing.getState();
      if (state !== "completed" && state !== "failed") {
        logger.info({ jobId }, "deduplicated exec job");
        return existing;
      }
      await existing.remove(); // finished job under this key — allow a fresh run
    }
    return execQueue.add("exec", data, { ...JOB_OPTS, jobId });
  }
  return execQueue.add("exec", data, JOB_OPTS);
}

/** Enqueue and wait — used by the synchronous /exec endpoint the edge function calls. */
export async function runJobAndWait(data: ExecJobData): Promise<ExecJobResult> {
  const job = await addExecJob(data);
  return job.waitUntilFinished(execEvents, (data.timeoutSeconds + 420) * 1000);
}

/** Re-enqueue a failed job (manual retry beyond the automatic attempts). */
export async function retryJob(jobId: string): Promise<{ state: string }> {
  const job = await execQueue.getJob(jobId);
  if (!job) throw Object.assign(new Error("Job not found"), { status: 404 });
  const state = await job.getState();
  if (state !== "failed") throw Object.assign(new Error(`Job is ${state}, only failed jobs can be retried`), { status: 409 });
  await job.retry();
  return { state: "waiting" };
}

export async function queueStats() {
  return execQueue.getJobCounts("waiting", "active", "completed", "failed", "delayed");
}
