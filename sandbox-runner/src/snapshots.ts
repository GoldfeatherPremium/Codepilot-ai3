import type Docker from "dockerode";
import { execInContainer } from "./docker.js";
import { shellQuote } from "./git.js";

// ---------------------------------------------------------------------------
// Workspace snapshots — point-in-time captures of /workspace using git
// plumbing. `git write-tree` + `git commit-tree` create an unreferenced commit
// object containing the FULL working tree (tracked + newly added files) without
// moving HEAD, touching branches, or appearing in history. Rollback restores
// the index and working tree to exactly that state and removes anything
// created since. Snapshots cost one tree object — cheap enough to take before
// every command execution.
// ---------------------------------------------------------------------------

export interface SnapshotInfo {
  id: string;           // commit sha
  label: string;
  createdAt: string;
}

export async function createSnapshot(
  container: Docker.Container,
  label = "snapshot",
): Promise<SnapshotInfo> {
  const r = await execInContainer(
    container,
    // GIT_INDEX_FILE keeps the snapshot's staging separate from the user's
    // real index, so in-progress `git add` state is never disturbed.
    `export GIT_INDEX_FILE=/tmp/.cp-snap-index && rm -f "$GIT_INDEX_FILE" && ` +
    `git add -A && tree=$(git write-tree) && ` +
    `parent=$(git rev-parse -q --verify HEAD || true) && ` +
    `if [ -n "$parent" ]; then git commit-tree "$tree" -p "$parent" -m ${shellQuote(label)}; ` +
    `else git commit-tree "$tree" -m ${shellQuote(label)}; fi`,
    { timeoutSeconds: 60 },
  );
  if (r.exitCode !== 0) throw new Error(`snapshot failed: ${r.stderr.slice(0, 500)}`);
  const id = r.stdout.trim().split("\n").pop()?.trim() ?? "";
  if (!/^[0-9a-f]{40}$/.test(id)) throw new Error(`snapshot failed: unexpected output`);
  return { id, label, createdAt: new Date().toISOString() };
}

export async function rollbackToSnapshot(
  container: Docker.Container,
  snapshotId: string,
): Promise<void> {
  assertSha(snapshotId);
  const r = await execInContainer(
    container,
    // read-tree --reset -u: make index + working tree match the snapshot;
    // clean -fd: remove files created after it (snapshot's tree is authoritative).
    `git cat-file -e ${snapshotId}^{commit} && ` +
    `git read-tree --reset -u ${snapshotId} && git clean -fd`,
    { timeoutSeconds: 120 },
  );
  if (r.exitCode !== 0) throw new Error(`rollback failed: ${r.stderr.slice(0, 500)}`);
}

export async function compareSnapshots(
  container: Docker.Container,
  fromId: string,
  toId: string | "worktree",
): Promise<{ stat: string; diff: string; files: { path: string; additions: number; deletions: number }[] }> {
  assertSha(fromId);
  const target = toId === "worktree" ? "" : (assertSha(toId), toId);

  const stat = await execInContainer(
    container,
    target
      ? `git diff --numstat ${fromId} ${target}`
      : `export GIT_INDEX_FILE=/tmp/.cp-cmp-index && rm -f "$GIT_INDEX_FILE" && git add -A && git diff --numstat ${fromId} $(git write-tree)`,
    { timeoutSeconds: 60 },
  );
  const full = await execInContainer(
    container,
    target
      ? `git diff ${fromId} ${target}`
      : `export GIT_INDEX_FILE=/tmp/.cp-cmp-index && git diff ${fromId} $(git write-tree)`,
    { timeoutSeconds: 60 },
  );

  const files = stat.stdout.split("\n").filter(Boolean).map((line) => {
    const [add, del, ...rest] = line.split("\t");
    return {
      path: rest.join("\t"),
      additions: add === "-" ? 0 : Number(add),
      deletions: del === "-" ? 0 : Number(del),
    };
  });

  return { stat: stat.stdout.slice(0, 50_000), diff: full.stdout.slice(0, 1_000_000), files };
}

function assertSha(sha: string): void {
  if (!/^[0-9a-f]{7,40}$/i.test(sha)) {
    const err = new Error(`invalid snapshot id: ${sha}`) as Error & { status: number };
    err.status = 400;
    throw err;
  }
}
