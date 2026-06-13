// ---------------------------------------------------------------------------
// Sandbox API — the canonical programmatic surface of the runner. Each
// function corresponds 1:1 to a REST route in server.ts; both the HTTP layer
// and any future in-process consumers (tests, CLI) go through here so behavior
// can never drift between them.
// ---------------------------------------------------------------------------
import { createSession, destroySession, getSession, type Session } from "./sessions.js";
import { cloneRepo, getDiff, commitChanges as gitCommit, pushBranch as gitPush, type DiffSummary } from "./git.js";
import {
  readWorkspaceFile, writeWorkspaceFile, editWorkspaceFile,
  deleteWorkspaceFile, listWorkspace,
} from "./files.js";
import { createSnapshot, rollbackToSnapshot, compareSnapshots, type SnapshotInfo } from "./snapshots.js";
import { execInContainer, type ExecResult } from "./docker.js";
import { config } from "./config.js";

function mustGet(sandboxId: string): Session {
  const s = getSession(sandboxId);
  if (!s) {
    const err = new Error("Sandbox not found or expired") as Error & { status: number };
    err.status = 404;
    throw err;
  }
  return s;
}

/** Create an isolated Ubuntu 24.04 sandbox container with hard resource limits. */
export async function createSandbox(opts: {
  repo?: string | null;
  branch?: string | null;
  githubToken?: string | null;
  stagedFiles?: Record<string, string>;
} = {}): Promise<{ sandboxId: string }> {
  const s = await createSession(opts);
  return { sandboxId: s.id };
}

/** Clone (or re-clone) a repository into an existing sandbox's /workspace. */
export async function cloneRepository(
  sandboxId: string,
  repo: string,
  branch: string | null,
  githubToken: string,
): Promise<void> {
  const s = mustGet(sandboxId);
  await execInContainer(s.container, `rm -rf /workspace/* /workspace/.[!.]* 2>/dev/null || true`, { timeoutSeconds: 30 });
  await cloneRepo(s.container, repo, branch, githubToken);
  s.repo = repo;
  s.branch = branch;
  s.githubToken = githubToken;
}

/** Execute a shell command in the sandbox (npm/pnpm/yarn/pip/pytest/php/composer/go/cargo/anything on PATH). */
export async function executeCommand(
  sandboxId: string,
  command: string,
  opts: { timeoutSeconds?: number; env?: Record<string, string>; onChunk?: (stream: "stdout" | "stderr", data: string) => void } = {},
): Promise<ExecResult> {
  const s = mustGet(sandboxId);
  s.busy = true;
  try {
    return await execInContainer(s.container, command, {
      timeoutSeconds: Math.min(opts.timeoutSeconds ?? config.DEFAULT_TIMEOUT_SECONDS, config.MAX_TIMEOUT_SECONDS),
      env: Object.entries(opts.env ?? {}).map(([k, v]) => `${k}=${v}`),
      onChunk: opts.onChunk,
    });
  } finally {
    s.busy = false;
    s.lastUsedAt = Date.now();
  }
}

export async function readFile(sandboxId: string, path: string) {
  return readWorkspaceFile(mustGet(sandboxId).container, path);
}

export async function writeFile(sandboxId: string, path: string, content: string) {
  return writeWorkspaceFile(mustGet(sandboxId).container, path, content);
}

export async function editFile(sandboxId: string, path: string, oldStr: string, newStr: string, replaceAll = false) {
  return editWorkspaceFile(mustGet(sandboxId).container, path, oldStr, newStr, replaceAll);
}

export async function deleteFile(sandboxId: string, path: string) {
  return deleteWorkspaceFile(mustGet(sandboxId).container, path);
}

export async function listFiles(sandboxId: string, prefix?: string) {
  return listWorkspace(mustGet(sandboxId).container, prefix);
}

/** Unified diff + per-file numstat of the working tree vs HEAD (untracked included). */
export async function generateDiff(sandboxId: string): Promise<DiffSummary> {
  return getDiff(mustGet(sandboxId).container);
}

export async function commitChanges(
  sandboxId: string,
  message: string,
  author: { name: string; email: string },
) {
  return gitCommit(mustGet(sandboxId).container, message, author);
}

export async function pushBranch(sandboxId: string, branch: string, githubToken?: string) {
  const s = mustGet(sandboxId);
  const token = githubToken ?? s.githubToken;
  if (!token) {
    const err = new Error("No GitHub token available for push") as Error & { status: number };
    err.status = 400;
    throw err;
  }
  return gitPush(s.container, branch, token);
}

export async function snapshotWorkspace(sandboxId: string, label?: string): Promise<SnapshotInfo> {
  const s = mustGet(sandboxId);
  const snap = await createSnapshot(s.container, label);
  s.snapshots.push(snap);
  if (s.snapshots.length > 100) s.snapshots.shift();
  return snap;
}

export function listSnapshots(sandboxId: string): SnapshotInfo[] {
  return mustGet(sandboxId).snapshots;
}

export async function rollbackSnapshot(sandboxId: string, snapshotId: string): Promise<void> {
  return rollbackToSnapshot(mustGet(sandboxId).container, snapshotId);
}

export async function diffSnapshots(sandboxId: string, from: string, to: string | "worktree") {
  return compareSnapshots(mustGet(sandboxId).container, from, to);
}

/** One-shot CPU/memory stats for a running sandbox (for /metrics). */
export async function sandboxStats(sandboxId: string): Promise<{ cpu_percent: number; memory_mb: number; memory_limit_mb: number } | null> {
  const s = mustGet(sandboxId);
  const raw = await s.container.stats({ stream: false }) as any;
  const cpuDelta = (raw.cpu_stats?.cpu_usage?.total_usage ?? 0) - (raw.precpu_stats?.cpu_usage?.total_usage ?? 0);
  const sysDelta = (raw.cpu_stats?.system_cpu_usage ?? 0) - (raw.precpu_stats?.system_cpu_usage ?? 0);
  const cpus = raw.cpu_stats?.online_cpus ?? 1;
  const cpuPercent = sysDelta > 0 ? (cpuDelta / sysDelta) * cpus * 100 : 0;
  return {
    cpu_percent: Math.round(cpuPercent * 10) / 10,
    memory_mb: Math.round((raw.memory_stats?.usage ?? 0) / 1048576),
    memory_limit_mb: Math.round((raw.memory_stats?.limit ?? 0) / 1048576),
  };
}

/** Force-remove the container and forget the session. Always safe to call. */
export async function destroySandbox(sandboxId: string): Promise<void> {
  await destroySession(sandboxId);
}
