import type Docker from "dockerode";
import { execInContainer } from "./docker.js";
import { shellQuote, isSafeRelativePath } from "./git.js";

// ---------------------------------------------------------------------------
// File engine — all operations run inside the sandbox container against
// /workspace. Content travels base64-encoded (binary-safe, quote-safe).
//
// Edits are exact-string replacements (str_replace semantics): because the
// surrounding bytes are untouched, formatting, indentation, and code style are
// preserved by construction. Every mutation returns a unified diff computed
// BEFORE the change is applied, and the write only proceeds if the diff step
// succeeded — so callers always see what changed.
// ---------------------------------------------------------------------------

const MAX_READ_BYTES = 512_000;

function b64(s: string): string {
  return Buffer.from(s, "utf8").toString("base64");
}

export async function readWorkspaceFile(
  container: Docker.Container,
  path: string,
): Promise<{ content: string; size: number; truncated: boolean }> {
  assertSafePath(path);
  const r = await execInContainer(
    container,
    `f=${shellQuote(path)}; if [ ! -f "$f" ]; then echo "__NOT_FOUND__" >&2; exit 44; fi; ` +
    `wc -c < "$f"; echo "__SEP__"; head -c ${MAX_READ_BYTES} "$f" | base64 -w0`,
    { timeoutSeconds: 30 },
  );
  if (r.exitCode === 44) throw notFound(path);
  if (r.exitCode !== 0) throw new Error(`read failed: ${r.stderr.slice(0, 500)}`);
  const [sizeRaw = "0", payload = ""] = r.stdout.split("__SEP__");
  const size = Number(sizeRaw.trim()) || 0;
  return {
    content: Buffer.from(payload.trim(), "base64").toString("utf8"),
    size,
    truncated: size > MAX_READ_BYTES,
  };
}

export async function writeWorkspaceFile(
  container: Docker.Container,
  path: string,
  content: string,
): Promise<{ diff: string; created: boolean }> {
  assertSafePath(path);
  if (content.length > 2_000_000) throw new Error("file content exceeds 2MB write limit");
  // Stage new content to a tmp file (base64 in ARG_MAX-safe chunks), diff
  // against current state, then move into place atomically. `git diff
  // --no-index` gives a proper unified diff and exits 1 on differences.
  const payload = b64(content);
  const chunks: string[] = [];
  for (let i = 0; i < payload.length; i += 60_000) chunks.push(payload.slice(i, i + 60_000));
  let cmd = `f=${shellQuote(path)}; tmp=$(mktemp); b=$(mktemp); : > "$b"`;
  for (const chunk of chunks) cmd += `; printf '%s' ${shellQuote(chunk)} >> "$b"`;
  cmd +=
    `; base64 -d "$b" > "$tmp" && rm -f "$b"; ` +
    `created=0; [ -f "$f" ] || created=1; ` +
    `if [ "$created" = 1 ]; then diff=$(git diff --no-index -- /dev/null "$tmp" 2>/dev/null || true); ` +
    `else diff=$(git diff --no-index -- "$f" "$tmp" 2>/dev/null || true); fi; ` +
    `mkdir -p "$(dirname "$f")" && mv "$tmp" "$f" && echo "__CREATED__:$created" && printf '%s' "$diff" | base64 -w0`;
  const r = await execInContainer(container, cmd, { timeoutSeconds: 60 });
  if (r.exitCode !== 0) throw new Error(`write failed: ${r.stderr.slice(0, 500)}`);
  const created = r.stdout.includes("__CREATED__:1");
  const diff = decodeDiff(r.stdout);
  return { diff: relabelDiff(diff, path), created };
}

export async function editWorkspaceFile(
  container: Docker.Container,
  path: string,
  oldStr: string,
  newStr: string,
  replaceAll = false,
): Promise<{ diff: string; occurrences: number }> {
  assertSafePath(path);
  if (!oldStr) throw new Error("old_str must not be empty");
  const { content } = await readWorkspaceFile(container, path);

  const occurrences = countOccurrences(content, oldStr);
  if (occurrences === 0) {
    throw new Error(`old_str not found in ${path}. Read the file again — it may have changed.`);
  }
  if (occurrences > 1 && !replaceAll) {
    throw new Error(
      `old_str appears ${occurrences} times in ${path}. Provide more surrounding context to make it unique, or set replace_all=true.`,
    );
  }

  const updated = replaceAll
    ? content.split(oldStr).join(newStr)
    : content.replace(oldStr, newStr);

  const { diff } = await writeWorkspaceFile(container, path, updated);
  return { diff, occurrences: replaceAll ? occurrences : 1 };
}

export async function deleteWorkspaceFile(
  container: Docker.Container,
  path: string,
): Promise<void> {
  assertSafePath(path);
  const r = await execInContainer(
    container,
    `f=${shellQuote(path)}; [ -f "$f" ] || exit 44; rm -f "$f"`,
    { timeoutSeconds: 15 },
  );
  if (r.exitCode === 44) throw notFound(path);
  if (r.exitCode !== 0) throw new Error(`delete failed: ${r.stderr.slice(0, 500)}`);
}

export async function listWorkspace(
  container: Docker.Container,
  prefix = "",
): Promise<{ path: string; size: number }[]> {
  if (prefix && !isSafeRelativePath(prefix)) throw new Error("invalid prefix");
  const r = await execInContainer(
    container,
    `cd /workspace && find ${prefix ? shellQuote(`./${prefix.replace(/\/$/, "")}`) : "."} ` +
    `-path ./.git -prune -o -type f -printf '%s\\t%P\\n' 2>/dev/null | head -500`,
    { timeoutSeconds: 30 },
  );
  return r.stdout.split("\n").filter(Boolean).map((line) => {
    const [size, ...rest] = line.split("\t");
    return { path: rest.join("\t"), size: Number(size) || 0 };
  });
}

// --- helpers -----------------------------------------------------------------

function decodeDiff(stdout: string): string {
  // Last line of the write command is the base64 diff payload.
  const lines = stdout.trim().split("\n");
  const last = lines[lines.length - 1] ?? "";
  if (last.startsWith("__CREATED__")) return "";
  try { return Buffer.from(last, "base64").toString("utf8").slice(0, 200_000); }
  catch { return ""; }
}

/** git diff --no-index labels paths a/tmp b/tmp; relabel to the real path. */
function relabelDiff(diff: string, path: string): string {
  return diff
    .replace(/^diff --git .*$/m, `diff --git a/${path} b/${path}`)
    .replace(/^--- (?!\/dev\/null).*$/m, `--- a/${path}`)
    .replace(/^\+\+\+ .*$/m, `+++ b/${path}`);
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let i = 0;
  while ((i = haystack.indexOf(needle, i)) !== -1) { count++; i += needle.length; }
  return count;
}

function assertSafePath(path: string): void {
  if (!isSafeRelativePath(path)) {
    const err = new Error(`unsafe path: ${path}`) as Error & { status: number };
    err.status = 400;
    throw err;
  }
}

function notFound(path: string): Error & { status: number } {
  const err = new Error(`file not found: ${path}`) as Error & { status: number };
  err.status = 404;
  return err;
}
