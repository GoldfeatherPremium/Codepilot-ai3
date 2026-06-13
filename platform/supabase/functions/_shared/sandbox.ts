// ============================================================================
// sandbox.ts — typed client for the CodePilot Sandbox Runner.
//
// One sandbox is created per agent run (clone once, keep node_modules /
// virtualenvs / build caches warm across commands), and destroyed when the
// run finishes. execStreaming() consumes the runner's SSE log stream so
// stdout/stderr reach the database and the timeline while the command runs.
// ============================================================================

const SANDBOX_URL = Deno.env.get("SANDBOX_RUNNER_URL");
const SANDBOX_TOKEN = Deno.env.get("SANDBOX_RUNNER_TOKEN");

export function sandboxConfigured(): boolean {
  return !!SANDBOX_URL && !!SANDBOX_TOKEN;
}

export interface ExecResult {
  exit_code: number;
  stdout: string;
  stderr: string;
  sandbox_id: string;
  timed_out: boolean;
  duration_ms: number;
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  if (!sandboxConfigured()) throw new Error("Sandbox runner not configured (set SANDBOX_RUNNER_URL / SANDBOX_RUNNER_TOKEN).");
  const res = await fetch(`${SANDBOX_URL}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${SANDBOX_TOKEN}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `sandbox runner ${res.status}`);
  return data as T;
}

// --- lifecycle ---------------------------------------------------------------

export async function createSandbox(opts: {
  repo?: string | null; branch?: string | null; githubToken?: string | null;
  stagedFiles?: Record<string, string | null>;
}): Promise<string> {
  const staged: Record<string, string> = {};
  for (const [k, v] of Object.entries(opts.stagedFiles ?? {})) if (v !== null) staged[k] = v;
  const r = await call<{ sandbox_id: string }>("POST", "/sandboxes", {
    repo: opts.repo ?? null, branch: opts.branch ?? null,
    github_token: opts.githubToken ?? null,
    staged_files: Object.keys(staged).length ? staged : undefined,
  });
  return r.sandbox_id;
}

export async function destroySandbox(sandboxId: string): Promise<void> {
  await call("DELETE", `/sandboxes/${sandboxId}`).catch(() => { /* already gone */ });
}

// --- execution ------------------------------------------------------------------

export async function exec(
  sandboxId: string,
  command: string,
  opts: { timeoutSeconds?: number; jobKey?: string } = {},
): Promise<ExecResult> {
  return call<ExecResult>("POST", `/sandboxes/${sandboxId}/exec`, {
    command, timeout_seconds: opts.timeoutSeconds, job_key: opts.jobKey,
  });
}

/**
 * Execute with real-time log streaming. Starts the job async, attaches to the
 * SSE stream, and invokes onChunk for every stdout/stderr fragment until the
 * runner reports completion. Falls back to the final result if the stream
 * drops — the job itself is unaffected.
 */
export async function execStreaming(
  sandboxId: string,
  command: string,
  opts: {
    timeoutSeconds?: number;
    jobKey?: string;
    onChunk: (stream: "stdout" | "stderr", data: string) => void | Promise<void>;
  },
): Promise<ExecResult> {
  const started = await call<{ job_id: string; stream_url: string }>(
    "POST", `/sandboxes/${sandboxId}/exec`,
    { command, timeout_seconds: opts.timeoutSeconds, job_key: opts.jobKey, async: true },
  );

  const res = await fetch(`${SANDBOX_URL}${started.stream_url}`, {
    headers: { Authorization: `Bearer ${SANDBOX_TOKEN}`, Accept: "text/event-stream" },
  });
  if (!res.ok || !res.body) throw new Error(`stream attach failed: ${res.status}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finalResult: ExecResult | null = null;
  let failedReason: string | null = null;

  const deadline = Date.now() + ((opts.timeoutSeconds ?? 120) + 420) * 1000;

  try {
    while (Date.now() < deadline) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE frames are separated by a blank line.
      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        let event = "message";
        let data = "";
        for (const line of frame.split("\n")) {
          if (line.startsWith("event: ")) event = line.slice(7).trim();
          else if (line.startsWith("data: ")) data += line.slice(6);
        }
        if (!data) continue;
        if (event === "log") {
          try {
            const chunk = JSON.parse(data) as { stream: "stdout" | "stderr"; data: string };
            await opts.onChunk(chunk.stream, chunk.data);
          } catch { /* malformed chunk — skip */ }
        } else if (event === "done") {
          try {
            const done = JSON.parse(data) as { state: string; result: (ExecResult & { exitCode?: number }) | null; error: string | null };
            if (done.result) {
              // worker returns camelCase internally; normalize both shapes
              const r = done.result as Record<string, unknown>;
              finalResult = {
                exit_code: (r.exit_code ?? r.exitCode) as number,
                stdout: (r.stdout ?? "") as string,
                stderr: (r.stderr ?? "") as string,
                sandbox_id: (r.sandbox_id ?? r.sandboxId ?? sandboxId) as string,
                timed_out: (r.timed_out ?? r.timedOut ?? false) as boolean,
                duration_ms: (r.duration_ms ?? r.durationMs ?? 0) as number,
              };
            }
            failedReason = done.error;
          } catch { /* fallthrough to error below */ }
          reader.cancel().catch(() => {});
          if (finalResult) return finalResult;
          throw new Error(failedReason ?? "execution failed");
        }
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  throw new Error(failedReason ?? "log stream ended without completion");
}

// --- files ------------------------------------------------------------------------

export async function readFile(sandboxId: string, path: string): Promise<{ content: string; size: number; truncated: boolean }> {
  return call("GET", `/sandboxes/${sandboxId}/files?path=${encodeURIComponent(path)}`);
}

export async function writeFile(sandboxId: string, path: string, content: string): Promise<{ diff: string; created: boolean }> {
  return call("PUT", `/sandboxes/${sandboxId}/files`, { path, content });
}

export async function editFile(
  sandboxId: string, path: string, oldStr: string, newStr: string, replaceAll = false,
): Promise<{ diff: string; occurrences: number }> {
  return call("PATCH", `/sandboxes/${sandboxId}/files`, { path, old_str: oldStr, new_str: newStr, replace_all: replaceAll });
}

export async function deleteFile(sandboxId: string, path: string): Promise<void> {
  await call("DELETE", `/sandboxes/${sandboxId}/files?path=${encodeURIComponent(path)}`);
}

export async function listFiles(sandboxId: string, prefix?: string): Promise<{ files: { path: string; size: number }[] }> {
  return call("GET", `/sandboxes/${sandboxId}/files${prefix ? `?prefix=${encodeURIComponent(prefix)}` : ""}`);
}

// --- git ---------------------------------------------------------------------------

export async function diff(sandboxId: string): Promise<{ diff: string; files: { path: string; status: string; additions: number; deletions: number }[] }> {
  return call("GET", `/sandboxes/${sandboxId}/diff`);
}

export async function commit(
  sandboxId: string, message: string, author: { name: string; email: string },
): Promise<{ sha: string; files_changed: number; additions: number; deletions: number }> {
  return call("POST", `/sandboxes/${sandboxId}/commit`, {
    message, author_name: author.name, author_email: author.email,
  });
}

export async function push(sandboxId: string, branch: string): Promise<void> {
  await call("POST", `/sandboxes/${sandboxId}/push`, { branch });
}

// --- snapshots ------------------------------------------------------------------------

export async function snapshot(sandboxId: string, label?: string): Promise<{ id: string; label: string; createdAt: string }> {
  return call("POST", `/sandboxes/${sandboxId}/snapshots`, { label });
}

export async function rollback(sandboxId: string, snapshotId: string): Promise<void> {
  await call("POST", `/sandboxes/${sandboxId}/snapshots/rollback`, { snapshot_id: snapshotId });
}
