import type Docker from "dockerode";
import { execInContainer } from "./docker.js";
import { config } from "./config.js";

// ---------------------------------------------------------------------------
// All git operations run INSIDE the sandbox container against /workspace.
// The GitHub token is injected per-command as an http.extraHeader sourced from
// an environment variable — it never appears in argv, the remote URL, on disk,
// or in captured output (the runner also redacts token patterns).
// ---------------------------------------------------------------------------

function authedGit(subcommand: string): string {
  // $GIT_AUTH_HEADER is set via exec Env only for git commands that need it.
  return `git -c http.extraHeader="$GIT_AUTH_HEADER" ${subcommand}`;
}

function tokenEnv(githubToken: string): string[] {
  const basic = Buffer.from(`x-access-token:${githubToken}`).toString("base64");
  return [`GIT_AUTH_HEADER=AUTHORIZATION: basic ${basic}`, "GIT_TERMINAL_PROMPT=0"];
}

export async function cloneRepo(
  container: Docker.Container,
  repoFullName: string,
  branch: string | null,
  githubToken: string,
): Promise<void> {
  const url = `https://github.com/${repoFullName}.git`;
  const branchArg = branch ? `--branch ${shellQuote(branch)}` : "";
  const cmd = authedGit(`clone --depth 50 ${branchArg} ${shellQuote(url)} /workspace`);

  const result = await execInContainer(container, cmd, {
    timeoutSeconds: Math.min(config.MAX_TIMEOUT_SECONDS, 300),
    env: tokenEnv(githubToken),
    workdir: "/home/sandbox",
  });
  if (result.exitCode !== 0) {
    // A requested agent branch may not exist remotely yet — fall back to the
    // default branch and create it locally.
    if (branch) {
      const fallback = await execInContainer(
        container,
        `${authedGit(`clone --depth 50 ${shellQuote(url)} /workspace`)} && cd /workspace && git checkout -b ${shellQuote(branch)}`,
        { timeoutSeconds: 300, env: tokenEnv(githubToken), workdir: "/home/sandbox" },
      );
      if (fallback.exitCode === 0) return;
      throw new Error(`git clone failed: ${fallback.stderr.slice(0, 2000)}`);
    }
    throw new Error(`git clone failed: ${result.stderr.slice(0, 2000)}`);
  }
}

/** Overlay the agent's staged (not-yet-committed) edits onto the working tree. */
export async function applyStagedFiles(
  container: Docker.Container,
  stagedFiles: Record<string, string>,
): Promise<void> {
  for (const [path, content] of Object.entries(stagedFiles)) {
    if (!isSafeRelativePath(path)) continue; // refuse traversal / absolute paths
    const b64 = Buffer.from(content, "utf8").toString("base64");
    const cmd = `mkdir -p "$(dirname ${shellQuote(path)})" && printf '%s' ${shellQuote(b64)} | base64 -d > ${shellQuote(path)}`;
    const r = await execInContainer(container, cmd, { timeoutSeconds: 30 });
    if (r.exitCode !== 0) throw new Error(`failed to stage ${path}: ${r.stderr.slice(0, 500)}`);
  }
}

export interface DiffSummary {
  diff: string;
  files: { path: string; status: string; additions: number; deletions: number }[];
}

export async function getDiff(container: Docker.Container): Promise<DiffSummary> {
  const numstat = await execInContainer(
    container,
    `git add -A -N && git diff --numstat HEAD && echo '---STATUS---' && git status --porcelain`,
    { timeoutSeconds: 60 },
  );
  const full = await execInContainer(container, `git diff HEAD`, { timeoutSeconds: 60 });

  const [numPart = "", statusPart = ""] = numstat.stdout.split("---STATUS---");
  const statusByPath = new Map<string, string>();
  for (const line of statusPart.split("\n")) {
    const m = line.match(/^(..)\s+(.*)$/);
    if (m) statusByPath.set(m[2].trim(), m[1].trim());
  }

  const files = numPart
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [add, del, ...rest] = line.split("\t");
      const path = rest.join("\t");
      return {
        path,
        status: statusByPath.get(path) ?? "M",
        additions: add === "-" ? 0 : Number(add),
        deletions: del === "-" ? 0 : Number(del),
      };
    });

  return { diff: full.stdout.slice(0, 2_000_000), files };
}

export async function commitChanges(
  container: Docker.Container,
  message: string,
  author: { name: string; email: string },
): Promise<{ sha: string; filesChanged: number; additions: number; deletions: number; filesDetail: { path: string; additions: number; deletions: number }[] }> {
  const cmd = [
    `git config user.name ${shellQuote(author.name)}`,
    `git config user.email ${shellQuote(author.email)}`,
    `git add -A`,
    `git commit -m ${shellQuote(message)}`,
    `git rev-parse HEAD`,
    `echo '---NUMSTAT---'`,
    `git show --numstat --format= HEAD`,
  ].join(" && ");

  const r = await execInContainer(container, cmd, { timeoutSeconds: 60 });
  if (r.exitCode !== 0) {
    if (/nothing to commit/i.test(r.stdout + r.stderr)) throw new Error("Nothing to commit — working tree clean");
    throw new Error(`git commit failed: ${(r.stderr || r.stdout).slice(0, 1000)}`);
  }
  const [head = "", numstatPart = ""] = r.stdout.split("---NUMSTAT---");
  const sha = head.trim().split("\n").find((l) => /^[0-9a-f]{40}$/.test(l.trim()))?.trim() ?? "";
  const filesDetail = numstatPart.split("\n").filter(Boolean).map((line) => {
    const [add, del, ...rest] = line.split("\t");
    return { path: rest.join("\t"), additions: add === "-" ? 0 : Number(add), deletions: del === "-" ? 0 : Number(del) };
  });
  return {
    sha,
    filesChanged: filesDetail.length,
    additions: filesDetail.reduce((s, f) => s + f.additions, 0),
    deletions: filesDetail.reduce((s, f) => s + f.deletions, 0),
    filesDetail,
  };
}

export async function pushBranch(
  container: Docker.Container,
  branch: string,
  githubToken: string,
): Promise<void> {
  const r = await execInContainer(
    container,
    authedGit(`push --set-upstream origin ${shellQuote(branch)}`),
    { timeoutSeconds: 120, env: tokenEnv(githubToken) },
  );
  if (r.exitCode !== 0) throw new Error(`git push failed: ${r.stderr.slice(0, 2000)}`);
}

// --- helpers ---------------------------------------------------------------

export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function isSafeRelativePath(p: string): boolean {
  return !p.startsWith("/") && !p.includes("..") && !p.includes("\0") && p.length < 512;
}
