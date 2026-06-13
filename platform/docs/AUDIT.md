# Repository Audit — Execution Layer Transformation

Full audit performed while building the execution layer. Every finding below is fixed in code, not just noted.

## Architectural weaknesses found and fixed

**Stateless execution (critical).** `execute_command` previously created a throwaway container per command: `npm install` state vanished before `npm test`, making real engineering work impossible. Fixed: one persistent sandbox per agent run (`agent-run` creates it at approval, destroys it in a `finally`), so installs, builds, and virtualenvs persist across every command, file edit, and verification in the run.

**Editing detached from execution (critical).** File edits were staged in edge-function memory and pushed via the GitHub API, so executed commands never saw the agent's edits except as a one-shot overlay. Fixed: in workspace mode all reads/writes/edits/deletes hit the real checkout through the runner's file engine; commits and pushes happen with actual git inside the container; diffs are real `git diff` output. The GitHub-API path remains only as a degraded fallback when no runner is configured, now clearly labeled to the model.

**No verification or self-correction (critical).** The agent could "finish" with broken code. Fixed: a verification gate intercepts `finish(success=true)` after any edit — project type is detected (npm/pnpm/yarn scripts, Cargo.toml, go.mod, pyproject/requirements + pytest, composer.json/phpunit), build then tests run, and failures veto the finish and enter the repair loop: the failure output is fed back, the model's next message is stored as root-cause `analysis` in `repair_attempts`, fixes are applied, and verification re-runs — up to `agents.max_repair_attempts` (default 3, per-agent column), after which attempts are marked `exhausted` and the task fails honestly. Every attempt persists with command, exit code, output excerpt, pre-failure snapshot sha, analysis, and fix summary.

**No live output.** Command output appeared only after completion. Fixed: the runner streams stdout/stderr over SSE; `agent-run` consumes the stream, appends throttled `log` events to `agent_runs.timeline` (rendered as a growing terminal block in the chat timeline via Realtime) and incrementally updates `execution_logs.stdout/stderr` while the command runs.

**No rollback safety.** Fixed: a git-plumbing snapshot (`write-tree` + `commit-tree` on a private index — zero disturbance to HEAD/index/worktree) is taken automatically before every execution and on workspace creation; rollback restores the exact tree (removing files created since, preserving ignored artifacts like `node_modules`); compare produces numstat + full patch between any two snapshots or against the worktree.

## Correctness bugs found and fixed

- `agent-run read_file`: `branchName in {} ? branchName : repo.default_branch` always read the default branch, so the agent re-read stale content after committing. Fixed (workspace mode reads the checkout; fallback reads the working branch once created).
- `execution_logs` error path wrote a nonexistent `finished_ms` column → fixed to `duration_ms`.
- Runner timeout-killer ran as root inside a `CapDrop: ALL` container, where even root lacks `CAP_KILL` → kills silently failed. Fixed: signal as the `sandbox` user (same-uid signaling needs no capability).
- File transfer through exec env vars would exceed Linux's 128 KB `MAX_ARG_STRLEN` → replaced with chunked base64 staging (write) and bounded reads; edits are exact-match single-occurrence replacements that fail loudly on ambiguity, preserving formatting byte-for-byte.
- BullMQ auto-retry (`attempts: 2`) retried "Session not found" — unrecoverable by definition → wrapped in `UnrecoverableError`. Command failures return results (never throw), so automatic retries apply only to genuine infrastructure errors.

## Security review

Containers: CPU (`NanoCpus`), RAM with swap disabled, PID cap, per-container overlay disk quota (xfs + pquota, provisioned by `install.sh`; graceful degradation detected at create time), tmpfs `/tmp` (`noexec,nosuid`), `CapDrop: ALL`, `no-new-privileges`, default seccomp, non-root user, wall-clock timeout with process-group kill. No host mounts into sandboxes; the Docker socket is mounted only into the runner service on a single-purpose host (documented; gVisor swap-in path noted). GitHub tokens travel server→server over TLS, are injected per git command as an `http.extraHeader` from an env var (never argv/URL/disk), redacted from all captured output, and held only in runner memory per session. Bearer auth is constant-time over SHA-256 digests; per-client sliding-window rate limiting in Redis; job idempotency keys make duplicate execution structurally impossible. Path traversal is rejected on every file/staging operation. RLS (forced) covers the three new tables; writes go through service role only.

## Scalability

Queue concurrency, session capacity with idle-eviction + TTL reaper + boot-time orphan sweep, capped timeline (400 events) and output buffers, batched symbol/dependency inserts (500 rows), bounded embedding set per sync, iteration budget that grows with repair attempts but is hard-capped at 100, and a `/metrics` endpoint (queue depth, per-sandbox CPU/RAM, limits, Docker info) with a cron healthcheck that restarts the stack after two consecutive failures.

## Placeholder sweep

No TODO/FIXME/mock/stub implementations remain in platform edge functions, frontend, or runner source (the only "placeholder" matches are HTML input attributes). The previous `// Fly machines / Firecracker pool` aspirational comment is gone — the runner referenced is the real one in `sandbox-runner/`.
