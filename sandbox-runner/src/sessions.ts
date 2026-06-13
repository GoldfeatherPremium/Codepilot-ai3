import type Docker from "dockerode";
import { nanoid } from "nanoid";
import { createSandboxContainer, destroyContainer } from "./docker.js";
import { cloneRepo, applyStagedFiles } from "./git.js";
import type { SnapshotInfo } from "./snapshots.js";
import { config } from "./config.js";
import { logger } from "./middleware.js";

export interface Session {
  id: string;
  container: Docker.Container;
  repo: string | null;
  branch: string | null;
  /** Held in memory only, for commit/push within this session. Never persisted. */
  githubToken: string | null;
  snapshots: SnapshotInfo[];
  createdAt: number;
  lastUsedAt: number;
  busy: boolean;
}

const sessions = new Map<string, Session>();

export function getSession(id: string): Session | undefined {
  const s = sessions.get(id);
  if (s) s.lastUsedAt = Date.now();
  return s;
}

export function sessionCount(): number {
  return sessions.size;
}

export function listSessionsInfo(): { id: string; repo: string | null; branch: string | null; busy: boolean; age_seconds: number; idle_seconds: number; snapshot_count: number }[] {
  const now = Date.now();
  return [...sessions.values()].map((s) => ({
    id: s.id, repo: s.repo, branch: s.branch, busy: s.busy,
    age_seconds: Math.floor((now - s.createdAt) / 1000),
    idle_seconds: Math.floor((now - s.lastUsedAt) / 1000),
    snapshot_count: s.snapshots.length,
  }));
}

export async function createSession(opts: {
  repo?: string | null;
  branch?: string | null;
  githubToken?: string | null;
  stagedFiles?: Record<string, string>;
}): Promise<Session> {
  if (sessions.size >= config.MAX_SESSIONS) {
    // Evict the oldest idle session before refusing.
    const idle = [...sessions.values()].filter((s) => !s.busy).sort((a, b) => a.lastUsedAt - b.lastUsedAt)[0];
    if (idle) await destroySession(idle.id);
    if (sessions.size >= config.MAX_SESSIONS) {
      const err = new Error("Sandbox capacity reached — try again shortly") as Error & { status: number };
      err.status = 503;
      throw err;
    }
  }

  const id = nanoid(12);
  const container = await createSandboxContainer(id);
  const session: Session = {
    id,
    container,
    repo: opts.repo ?? null,
    branch: opts.branch ?? null,
    githubToken: opts.githubToken ?? null,
    snapshots: [],
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
    busy: false,
  };
  sessions.set(id, session);

  try {
    if (opts.repo && opts.githubToken) {
      await cloneRepo(container, opts.repo, opts.branch ?? null, opts.githubToken);
    }
    if (opts.stagedFiles && Object.keys(opts.stagedFiles).length > 0) {
      await applyStagedFiles(container, opts.stagedFiles);
    }
  } catch (e) {
    await destroySession(id);
    throw e;
  }

  logger.info({ sessionId: id, repo: opts.repo, branch: opts.branch }, "session created");
  return session;
}

export async function destroySession(id: string): Promise<void> {
  const s = sessions.get(id);
  if (!s) return;
  sessions.delete(id);
  s.githubToken = null;
  await destroyContainer(s.container);
  logger.info({ sessionId: id }, "session destroyed");
}

export async function destroyAllSessions(): Promise<void> {
  await Promise.allSettled([...sessions.keys()].map(destroySession));
}

// Reaper: idle sessions are destroyed after SESSION_TTL_SECONDS so abandoned
// containers never accumulate.
export function startReaper(): NodeJS.Timeout {
  return setInterval(async () => {
    const cutoff = Date.now() - config.SESSION_TTL_SECONDS * 1000;
    for (const s of sessions.values()) {
      if (!s.busy && s.lastUsedAt < cutoff) {
        logger.info({ sessionId: s.id }, "reaping idle session");
        await destroySession(s.id);
      }
    }
  }, 30_000);
}
