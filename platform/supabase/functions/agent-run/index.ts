// ============================================================================
// agent-run — the orchestration core of the software-engineering agent.
//
//   action=plan     prompt → memory recall → step plan → awaiting_approval
//   action=approve  workspace run loop (sandbox) with autonomous repair:
//                     Plan → Edit → Build → Test → Analyze failure → Fix → Retry
//   action=reject   task → rejected
//   action=chat     conversational turn with memory recall
//
// Two execution modes:
//   WORKSPACE (sandbox runner configured): one isolated container per run —
//     clone once, real file edits, real command execution with live log
//     streaming, git-level diffs/commits/pushes, snapshots before every
//     execution, and a verification-gated finish with a repair loop.
//   FALLBACK (no runner): GitHub-API staged-file editing; no execution.
//
// Every step lands in agent_runs.timeline + agent_messages (Realtime), every
// command in execution_logs (streamed incrementally), every repair attempt in
// repair_attempts with the model's root-cause analysis.
// ============================================================================

import { handleOptions, json } from "../_shared/cors.ts";
import { adminClient, requireUser } from "../_shared/supabase.ts";
import { decryptSecret } from "../_shared/crypto.ts";
import { GitHubClient } from "../_shared/github.ts";
import * as sb from "../_shared/sandbox.ts";
import {
  complete, embed, estimateCost,
  type ChatMessage, type ProviderConfig, type ToolDef,
} from "../_shared/providers.ts";

const MAX_FILE_BYTES = 200_000;
const MAX_TOOL_OUTPUT = 24_000;
const HARD_ITERATION_CAP = 100;

Deno.serve(async (req) => {
  const opt = handleOptions(req); if (opt) return opt;
  try {
    const { user } = await requireUser(req);
    const db = adminClient();
    const body = await req.json();
    const { action } = body as { action: "plan" | "approve" | "reject" | "chat" };

    const { data: allowed } = await db.rpc("check_rate_limit", {
      p_user_id: user.id, p_bucket: "agent_run", p_limit: 30, p_window_seconds: 3600,
    });
    if (!allowed) return json({ error: "Rate limit exceeded. Try again in a few minutes." }, 429);

    switch (action) {
      case "plan":    return await planTask(db, user.id, body);
      case "approve": return await executeTask(db, user.id, body.taskId);
      case "reject":  return await rejectTask(db, user.id, body.taskId, body.reason);
      case "chat":    return await chatTurn(db, user.id, body);
      default:        return json({ error: "Unknown action" }, 400);
    }
  } catch (e) {
    const status = (e as { status?: number }).status ?? 500;
    return json({ error: (e as Error).message }, status);
  }
});

// ---------------------------------------------------------------------------
// Context assembly
// ---------------------------------------------------------------------------
async function loadAgentContext(db: any, userId: string, agentId: string) {
  const { data: agent, error } = await db.from("agents")
    .select("*, repositories(*), provider_configs(*)")
    .eq("id", agentId).eq("user_id", userId).single();
  if (error || !agent) throw Object.assign(new Error("Agent not found"), { status: 404 });

  let pc = agent.provider_configs;
  if (!pc) {
    const { data } = await db.from("provider_configs")
      .select("*").eq("user_id", userId).eq("is_default", true).single();
    pc = data;
  }
  if (!pc) throw Object.assign(new Error("No AI provider configured. Add one in AI Providers."), { status: 400 });

  const providerCfg: ProviderConfig = {
    provider: pc.provider,
    apiKey: await decryptSecret(pc.key_ciphertext, pc.key_iv),
    model: agent.model || pc.default_model,
    endpointUrl: pc.endpoint_url,
    region: pc.region,
  };

  let gh: GitHubClient | null = null;
  const { data: u } = await db.from("users")
    .select("github_token_ciphertext, github_token_iv").eq("id", userId).single();
  if (u?.github_token_ciphertext) {
    gh = new GitHubClient(await decryptSecret(u.github_token_ciphertext, u.github_token_iv));
  }

  return { agent, repo: agent.repositories, providerCfg, gh, embedKey: await embeddingKey(db, userId, providerCfg) };
}

async function embeddingKey(db: any, userId: string, fallback: ProviderConfig): Promise<string | null> {
  if (fallback.provider === "openai") return fallback.apiKey;
  const { data } = await db.from("provider_configs")
    .select("key_ciphertext, key_iv").eq("user_id", userId).eq("provider", "openai").limit(1).maybeSingle();
  return data ? await decryptSecret(data.key_ciphertext, data.key_iv) : null;
}

async function recallMemories(db: any, userId: string, repoId: string | null, query: string, embedKey: string | null) {
  if (!embedKey) return [];
  try {
    const vec = await embed(embedKey, query);
    const { data } = await db.rpc("match_memories", {
      p_user_id: userId, p_query_embedding: vec,
      p_repository_id: repoId, p_match_count: 8, p_min_similarity: 0.68,
    });
    for (const m of data ?? []) await db.rpc("touch_memory", { p_memory_id: m.id });
    return data ?? [];
  } catch { return []; }
}

// ---------------------------------------------------------------------------
// action=plan
// ---------------------------------------------------------------------------
async function planTask(db: any, userId: string, body: any) {
  const { agentId, prompt } = body;
  const ctx = await loadAgentContext(db, userId, agentId);

  const { data: task } = await db.from("agent_tasks").insert({
    user_id: userId, agent_id: agentId, repository_id: ctx.repo?.id ?? null,
    title: prompt.slice(0, 120), prompt, status: "planning",
  }).select().single();

  const memories = await recallMemories(db, userId, ctx.repo?.id ?? null, prompt, ctx.embedKey);
  const memoryBlock = memories.length
    ? `\n\nRelevant long-term memory:\n${memories.map((m: any) => `- [${m.category}] ${m.title}: ${m.content}`).join("\n")}`
    : "";

  const result = await complete(ctx.providerCfg, [
    {
      role: "system",
      content: `You are a senior software engineering agent planning a coding task.
Repository: ${ctx.repo ? `${ctx.repo.full_name} (default branch ${ctx.repo.default_branch}, languages: ${Object.keys(ctx.repo.languages ?? {}).join(", ")})` : "none attached"}.
Execution environment: ${sb.sandboxConfigured() ? "full sandbox — you will be able to run builds, tests, and arbitrary commands" : "no sandbox — file edits via API only, no command execution"}.
${ctx.agent.system_prompt}${memoryBlock}

Produce a concise execution plan as STRICT JSON, no markdown fences:
{"title": "...", "steps": [{"step": 1, "title": "...", "detail": "..."}]}
4–8 steps. Steps must be concrete and verifiable. If the environment supports execution, include a verification step (build and/or tests).`,
    },
    { role: "user", content: prompt },
  ], { temperature: 0.1, maxTokens: 2000 });

  await db.rpc("record_usage", {
    p_user_id: userId, p_run_id: null, p_provider: ctx.providerCfg.provider,
    p_model: ctx.providerCfg.model, p_input: result.usage.inputTokens,
    p_output: result.usage.outputTokens,
    p_cost: estimateCost(ctx.providerCfg.model, result.usage.inputTokens, result.usage.outputTokens),
  });

  let plan;
  try {
    plan = JSON.parse(result.text.replace(/```json|```/g, "").trim());
  } catch {
    await db.from("agent_tasks").update({ status: "failed", error: "Plan generation returned invalid JSON" }).eq("id", task.id);
    return json({ error: "Plan generation failed — try again or switch models." }, 502);
  }
  plan.steps = (plan.steps ?? []).map((s: any) => ({ ...s, status: "pending" }));

  await db.from("agent_tasks").update({
    status: "awaiting_approval", title: plan.title ?? task.title, plan,
  }).eq("id", task.id);

  await db.from("agent_messages").insert({
    agent_id: agentId, task_id: task.id, user_id: userId, role: "assistant",
    content: `I've drafted a plan for **${plan.title}**. Review the steps and approve to start execution.`,
    parts: [{ type: "plan", plan }],
  });

  return json({ taskId: task.id, plan });
}

async function rejectTask(db: any, userId: string, taskId: string, reason?: string) {
  await db.from("agent_tasks").update({ status: "rejected", rejection_reason: reason ?? null })
    .eq("id", taskId).eq("user_id", userId);
  await db.rpc("write_audit", {
    p_user_id: userId, p_action: "task_rejected", p_resource_type: "agent_task",
    p_resource_id: taskId, p_metadata: { reason },
  });
  return json({ ok: true });
}

// ---------------------------------------------------------------------------
// Agent tools — permission-gated; the workspace set is the full engineering
// toolbox, the fallback set degrades gracefully.
// ---------------------------------------------------------------------------
function buildTools(agent: any, hasRepo: boolean, workspace: boolean): ToolDef[] {
  const tools: ToolDef[] = [];

  if (hasRepo && agent.can_read_repo) {
    tools.push(
      { name: "search_codebase", description: "Hybrid semantic + path search over the indexed repository. Returns relevant files with summaries.", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
      { name: "search_symbols", description: "Look up functions/classes/types by name in the symbol index. Returns definition locations, signatures, and cross-file references (which files import the symbol).", parameters: { type: "object", properties: { name: { type: "string" }, kind: { type: "string", enum: ["function", "method", "class", "interface", "type", "enum", "const", "struct", "trait"] } }, required: ["name"] } },
      { name: "dependency_graph", description: "For one file: what it imports, what imports it, and the symbols it defines. Use before changing widely-imported files.", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
      { name: "read_file", description: "Read a file's content from the working tree.", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
      { name: "list_directory", description: "List files under a directory prefix in the working tree.", parameters: { type: "object", properties: { prefix: { type: "string" } }, required: ["prefix"] } },
    );
  }

  if (hasRepo && agent.can_edit_repo) {
    tools.push(
      { name: "edit_file", description: "Surgical edit: replace old_str (must match EXACTLY once, including whitespace) with new_str. Preserves all surrounding formatting. Preferred over rewriting whole files.", parameters: { type: "object", properties: { path: { type: "string" }, old_str: { type: "string" }, new_str: { type: "string" }, replace_all: { type: "boolean" } }, required: ["path", "old_str", "new_str"] } },
      { name: "create_file", description: "Create a new file with the given content. Fails if the file already exists (use edit_file or write_file for existing files).", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
      { name: "write_file", description: "Overwrite an entire existing file. Use edit_file for targeted changes.", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
      { name: "delete_file", description: "Delete a file from the working tree.", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
    );
  }

  if (hasRepo && agent.can_create_commits) {
    tools.push({ name: "commit_changes", description: workspace ? "Commit ALL current working-tree changes and push the working branch to origin. Returns sha and diff stats." : "Commit all staged file changes to the working branch.", parameters: { type: "object", properties: { message: { type: "string" } }, required: ["message"] } });
  }
  if (hasRepo && agent.can_create_prs) {
    tools.push({ name: "create_pull_request", description: "Open a PR from the working branch. Body must include Summary, Files changed, Risks, Testing notes sections. Commit and push first.", parameters: { type: "object", properties: { title: { type: "string" }, body: { type: "string" }, risks: { type: "array", items: { type: "string" } }, testing_notes: { type: "string" } }, required: ["title", "body"] } });
  }

  if (agent.can_execute_commands && workspace) {
    tools.push(
      { name: "execute_command", description: "Run any shell command in the persistent workspace container (npm/pnpm/yarn, pip/pytest, composer, go, cargo, …). State persists across calls. Output streams live.", parameters: { type: "object", properties: { command: { type: "string" }, timeout_seconds: { type: "number" } }, required: ["command"] } },
      { name: "run_build", description: "Detect the project type and run its build (npm/pnpm/yarn run build, go build ./..., cargo build, …). Pass command to override detection.", parameters: { type: "object", properties: { command: { type: "string" } } } },
      { name: "run_tests", description: "Detect the project type and run its test suite (npm test, pytest, go test ./..., cargo test, composer test, …). Pass command to override detection.", parameters: { type: "object", properties: { command: { type: "string" } } } },
    );
  }

  tools.push(
    { name: "save_memory", description: "Persist an important fact to long-term memory.", parameters: { type: "object", properties: { scope: { type: "string", enum: ["user", "repository", "task"] }, category: { type: "string" }, title: { type: "string" }, content: { type: "string" } }, required: ["scope", "title", "content"] } },
    { name: "update_step", description: "Mark a plan step as running/done/failed.", parameters: { type: "object", properties: { step: { type: "number" }, status: { type: "string", enum: ["running", "done", "failed"] } }, required: ["step", "status"] } },
    { name: "finish", description: "Conclude the task with a summary. In a sandboxed run, finishing with success=true triggers automatic build/test verification first — failures start the repair loop instead of finishing.", parameters: { type: "object", properties: { summary: { type: "string" }, success: { type: "boolean" } }, required: ["summary", "success"] } },
  );
  return tools;
}

// ---------------------------------------------------------------------------
// action=approve
// ---------------------------------------------------------------------------
async function executeTask(db: any, userId: string, taskId: string) {
  const { data: task } = await db.from("agent_tasks")
    .select("*").eq("id", taskId).eq("user_id", userId).single();
  if (!task) return json({ error: "Task not found" }, 404);
  if (task.status !== "awaiting_approval") return json({ error: `Task is ${task.status}, not awaiting approval` }, 409);

  const ctx = await loadAgentContext(db, userId, task.agent_id);
  const branchName = `codepilot/${taskId.slice(0, 8)}-${slug(task.title)}`;

  await db.from("agent_tasks").update({
    status: "running", plan_approved_at: new Date().toISOString(),
    plan_approved_by: userId, started_at: new Date().toISOString(), branch_name: branchName,
  }).eq("id", taskId);
  await db.rpc("write_audit", {
    p_user_id: userId, p_action: "task_approved", p_resource_type: "agent_task",
    p_resource_id: taskId, p_metadata: {},
  });

  const { data: run } = await db.from("agent_runs").insert({
    task_id: taskId, agent_id: task.agent_id, user_id: userId,
    status: "running", provider: ctx.providerCfg.provider, model: ctx.providerCfg.model,
    started_at: new Date().toISOString(),
  }).select().single();

  EdgeRuntime.waitUntil(runLoop(db, userId, task, run, ctx, branchName).catch(async (e) => {
    await db.from("agent_runs").update({ status: "failed", error: String(e), finished_at: new Date().toISOString() }).eq("id", run.id);
    await db.from("agent_tasks").update({ status: "failed", error: String(e) }).eq("id", taskId);
  }));

  return json({ runId: run.id, branch: branchName, status: "running" });
}

// ---------------------------------------------------------------------------
// The run loop
// ---------------------------------------------------------------------------
interface RunState {
  db: any; userId: string; task: any; run: any; agent: any; repo: any;
  gh: GitHubClient | null; ctx: any; branchName: string;
  workspace: boolean;
  sandboxId: string | null;
  staged: Map<string, string | null>;          // fallback mode only
  branchCreated: boolean;                       // fallback mode only
  pushed: boolean;                              // workspace: branch exists on origin
  dirtySinceVerify: boolean;                    // edits since last green verification
  repair: { attempts: number; openRowId: string | null };
  timeline: any[];
  logBuffer: { text: string; bytes: number; lastFlush: number };
  finished: boolean;
  finishArgs: { summary: string; success: boolean } | null;
}

async function runLoop(db: any, userId: string, task: any, run: any, ctx: any, branchName: string) {
  const { agent, repo, providerCfg, gh } = ctx;

  const st: RunState = {
    db, userId, task, run, agent, repo, gh, ctx, branchName,
    workspace: sb.sandboxConfigured() && !!repo && !!gh,
    sandboxId: null,
    staged: new Map(),
    branchCreated: false,
    pushed: false,
    dirtySinceVerify: false,
    repair: { attempts: 0, openRowId: null },
    timeline: [],
    logBuffer: { text: "", bytes: 0, lastFlush: 0 },
    finished: false,
    finishArgs: null,
  };

  const pushTimeline = async (event: any) => {
    st.timeline.push({ at: new Date().toISOString(), ...event });
    if (st.timeline.length > 400) st.timeline.splice(0, st.timeline.length - 400);
    await db.from("agent_runs").update({ timeline: st.timeline }).eq("id", run.id);
  };

  try {
    // --- workspace bring-up -------------------------------------------------
    if (st.workspace) {
      await pushTimeline({ type: "tool_call", tool: "create_sandbox", args: { repo: repo.full_name, branch: branchName } });
      st.sandboxId = await sb.createSandbox({
        repo: repo.full_name, branch: branchName, githubToken: gh!.authToken,
      });
      const snap = await sb.snapshot(st.sandboxId, "initial");
      await pushTimeline({ type: "snapshot", text: `workspace ready · snapshot ${snap.id.slice(0, 10)}`, args: { snapshot: snap.id } });
    }

    const memories = await recallMemories(db, userId, repo?.id ?? null, task.prompt, ctx.embedKey);
    const messages: ChatMessage[] = [
      {
        role: "system",
        content: `You are ${agent.name}, an autonomous software engineering agent.
${agent.system_prompt}

Repository: ${repo ? `${repo.full_name} (working branch: ${branchName}, base: ${repo.default_branch})` : "none"}.
Environment: ${st.workspace
  ? "PERSISTENT WORKSPACE — a real checkout in an isolated container. Files you edit stay edited; commands run for real; installs persist across commands."
  : "API-ONLY — edits are staged via the GitHub API; commands cannot run. Be conservative."}

Approved plan:
${(task.plan?.steps ?? []).map((s: any) => `${s.step}. ${s.title} — ${s.detail}`).join("\n")}

Long-term memory:
${memories.map((m: any) => `- [${m.category}] ${m.title}: ${m.content}`).join("\n") || "(none)"}

Rules:
- Work through the plan step by step; call update_step as you go.
- Read before you write. Prefer edit_file (exact-match replacement) over rewriting files — it preserves formatting and style by construction.
- ${st.workspace ? "Verify your work: run_build and run_tests before finishing. Install dependencies first if needed." : "You cannot execute anything; reason carefully about correctness."}
- Commit logically grouped changes with conventional-commit messages${agent.can_create_prs ? ", then open a PR with Summary / Files changed / Risks / Testing notes" : ""}.
- When done (or genuinely blocked), call finish with an honest summary.
- Save durable insights (architecture decisions, preferences, schema facts) with save_memory.`,
      },
      { role: "user", content: task.prompt },
    ];

    const tools = buildTools(agent, !!repo, st.workspace);
    const maxIterations = Math.min(HARD_ITERATION_CAP, agent.max_iterations + (agent.max_repair_attempts ?? 3) * 4);

    for (let i = 0; i < maxIterations && !st.finished; i++) {
      const result = await complete(providerCfg, messages, { tools, temperature: agent.temperature });
      const cost = estimateCost(providerCfg.model, result.usage.inputTokens, result.usage.outputTokens);
      await db.rpc("record_usage", {
        p_user_id: userId, p_run_id: run.id, p_provider: providerCfg.provider,
        p_model: providerCfg.model, p_input: result.usage.inputTokens,
        p_output: result.usage.outputTokens, p_cost: cost,
      });
      await db.from("agent_runs").update({ iterations: i + 1 }).eq("id", run.id);

      if (result.text.trim()) {
        await pushTimeline({ type: "thinking", text: result.text.slice(0, 2000) });
        await db.from("agent_messages").insert({
          agent_id: agent.id, task_id: task.id, run_id: run.id, user_id: userId,
          role: "assistant", content: result.text,
          input_tokens: result.usage.inputTokens, output_tokens: result.usage.outputTokens,
        });
        // The first assistant text after a repair trigger is the root-cause analysis.
        if (st.repair.openRowId) {
          await db.from("repair_attempts").update({ analysis: result.text.slice(0, 8000) })
            .eq("id", st.repair.openRowId);
        }
      }

      if (!result.toolCalls.length) {
        // Model stopped calling tools without finish — nudge once, then stop.
        if (i < maxIterations - 1 && !st.finishArgs) {
          messages.push({ role: "assistant", content: result.text });
          messages.push({ role: "user", content: "Continue with the plan. Use tools; call finish when the task is complete." });
          continue;
        }
        break;
      }

      messages.push({ role: "assistant", content: result.text, tool_calls: result.toolCalls });

      for (const call of result.toolCalls) {
        await pushTimeline({ type: "tool_call", tool: call.name, args: summarizeArgs(call) });
        let output: string;
        try {
          output = await dispatchTool(call.name, call.arguments, st, pushTimeline);
        } catch (e) {
          output = `ERROR: ${(e as Error).message}`;
        }
        await pushTimeline({ type: "tool_result", tool: call.name, preview: output.slice(0, 400) });
        messages.push({ role: "tool", tool_call_id: call.id, content: output.slice(0, MAX_TOOL_OUTPUT) });

        // --- verification gate + autonomous repair loop ----------------------
        if (call.name === "finish" && st.finishArgs?.success && st.workspace && agent.can_execute_commands && st.dirtySinceVerify) {
          const verdict = await verifyWorkspace(st, pushTimeline);
          if (verdict.ok) {
            st.dirtySinceVerify = false;
            await resolveOpenRepairs(st);
            await concludeTask(st, st.finishArgs);
            st.finished = true;
          } else {
            st.finishArgs = null; // veto the finish
            if (st.repair.attempts >= (agent.max_repair_attempts ?? 3)) {
              await db.from("repair_attempts").update({ status: "exhausted" }).eq("run_id", run.id).eq("status", "failed");
              await concludeTask(st, {
                summary: `Verification kept failing after ${st.repair.attempts} repair attempt(s). Last failure (${verdict.trigger}): ${verdict.excerpt.slice(0, 600)}`,
                success: false,
              });
              st.finished = true;
            } else {
              st.repair.attempts++;
              const { data: row } = await db.from("repair_attempts").insert({
                user_id: userId, run_id: run.id, task_id: task.id,
                attempt_no: st.repair.attempts, trigger: verdict.trigger,
                command: verdict.command, exit_code: verdict.exitCode,
                output_excerpt: verdict.excerpt.slice(0, 12_000),
                snapshot_before: verdict.snapshotBefore, status: "analyzing",
              }).select("id").single();
              st.repair.openRowId = row?.id ?? null;
              await pushTimeline({ type: "repair", text: `verification failed (${verdict.trigger}) — repair attempt ${st.repair.attempts}/${agent.max_repair_attempts ?? 3}` });
              messages.push({
                role: "user",
                content: `AUTONOMOUS REPAIR — attempt ${st.repair.attempts}/${agent.max_repair_attempts ?? 3}.
Verification failed before your finish was accepted.
Command: ${verdict.command}
Exit code: ${verdict.exitCode}
Output (tail):
${verdict.excerpt.slice(-6000)}

First, state the root cause in one or two sentences. Then fix it with the file tools, re-run the failing check yourself if useful, and call finish again. If you discover the failure is pre-existing on the base branch and unrelated to your change, say so explicitly in your finish summary.`,
              });
            }
          }
        } else if (call.name === "finish" && st.finishArgs) {
          await resolveOpenRepairs(st);
          await concludeTask(st, st.finishArgs);
          st.finished = true;
        }
        if (st.finished) break;
      }
    }

    if (!st.finished) {
      await db.from("agent_tasks").update({ status: "failed", error: "Max iterations reached" }).eq("id", task.id);
    }
    await db.from("agent_runs").update({
      status: st.finished ? "succeeded" : "failed",
      error: st.finished ? null : "Reached max iterations without finishing",
      finished_at: new Date().toISOString(),
    }).eq("id", run.id);
  } finally {
    if (st.sandboxId) {
      await sb.destroySandbox(st.sandboxId);
      await pushTimeline({ type: "tool_result", tool: "destroy_sandbox", preview: "workspace destroyed" });
    }
  }
}

async function resolveOpenRepairs(st: RunState) {
  if (!st.repair.openRowId) return;
  const fix = await (st.workspace && st.sandboxId
    ? sb.diff(st.sandboxId).then((d) => d.files.map((f) => `${f.path} (+${f.additions}/−${f.deletions})`).join(", ")).catch(() => "")
    : Promise.resolve(""));
  await st.db.from("repair_attempts").update({
    status: "fixed", resolved_at: new Date().toISOString(),
    fix_summary: fix ? `verification passed; working-tree delta: ${fix.slice(0, 2000)}` : "verification passed",
  }).eq("run_id", st.run.id).in("status", ["failed", "analyzing"]);
  st.repair.openRowId = null;
}

async function concludeTask(st: RunState, args: { summary: string; success: boolean }) {
  await st.db.from("agent_tasks").update({
    status: args.success ? "completed" : "failed",
    result_summary: args.summary, completed_at: new Date().toISOString(),
  }).eq("id", st.task.id);
  await st.db.from("agent_messages").insert({
    agent_id: st.agent.id, task_id: st.task.id, run_id: st.run.id, user_id: st.userId,
    role: "assistant", content: args.summary, parts: [{ type: "task_done", success: args.success }],
  });
}

// ---------------------------------------------------------------------------
// Verification: detect project commands, run build then tests.
// ---------------------------------------------------------------------------
interface ProjectCommands { install?: string; build?: string; test?: string }

async function detectProjectCommands(st: RunState): Promise<ProjectCommands> {
  const sid = st.sandboxId!;
  const tryRead = async (p: string) => { try { return (await sb.readFile(sid, p)).content; } catch { return null; } };

  const pkgRaw = await tryRead("package.json");
  if (pkgRaw) {
    let pkg: any = {};
    try { pkg = JSON.parse(pkgRaw); } catch { /* malformed — treat as scriptless */ }
    const pm = (await tryRead("pnpm-lock.yaml")) ? "pnpm" : (await tryRead("yarn.lock")) ? "yarn" : "npm";
    const scripts = pkg.scripts ?? {};
    return {
      install: pm === "npm" ? "npm install --no-audit --no-fund" : `${pm} install`,
      build: scripts.build ? `${pm} run build` : undefined,
      test: scripts.test && !/no test specified/i.test(scripts.test) ? (pm === "npm" ? "npm test" : `${pm} test`) : undefined,
    };
  }
  if (await tryRead("Cargo.toml")) return { build: "cargo build --quiet", test: "cargo test --quiet" };
  if (await tryRead("go.mod")) return { build: "go build ./...", test: "go test ./..." };
  const pyproject = await tryRead("pyproject.toml");
  const requirements = await tryRead("requirements.txt");
  if (pyproject || requirements) {
    const usesPytest = /pytest/.test(pyproject ?? "") || /pytest/.test(requirements ?? "");
    return {
      install: requirements ? "pip install -q -r requirements.txt" : "pip install -q -e . || true",
      test: usesPytest ? "python3 -m pytest -q" : undefined,
    };
  }
  const composer = await tryRead("composer.json");
  if (composer) {
    let c: any = {};
    try { c = JSON.parse(composer); } catch { /* ignore */ }
    return {
      install: "composer install --no-interaction --quiet",
      test: c.scripts?.test ? "composer test" : (await tryRead("phpunit.xml")) || (await tryRead("phpunit.xml.dist")) ? "./vendor/bin/phpunit" : undefined,
    };
  }
  return {};
}

async function verifyWorkspace(
  st: RunState,
  pushTimeline: (e: any) => Promise<void>,
): Promise<{ ok: true } | { ok: false; trigger: "build" | "test"; command: string; exitCode: number; excerpt: string; snapshotBefore: string | null }> {
  const cmds = await detectProjectCommands(st);
  const checks: { trigger: "build" | "test"; command: string }[] = [];
  if (cmds.build) checks.push({ trigger: "build", command: cmds.install ? `${cmds.install} && ${cmds.build}` : cmds.build });
  if (cmds.test) checks.push({ trigger: "test", command: cmds.test });
  if (!checks.length) return { ok: true }; // nothing detectable to verify

  await pushTimeline({ type: "repair", text: `verifying before finish: ${checks.map((c) => c.trigger).join(" + ")}` });
  for (const check of checks) {
    const { result, snapshotBefore } = await runStreamed(st, check.command, 600, check.trigger, pushTimeline);
    if (result.timed_out || result.exit_code !== 0) {
      return {
        ok: false, trigger: check.trigger, command: check.command,
        exitCode: result.exit_code,
        excerpt: `${result.stdout.slice(-6000)}\n${result.stderr.slice(-6000)}`.trim(),
        snapshotBefore,
      };
    }
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Streamed execution: snapshot → execution_logs row → SSE chunks to timeline
// and incremental execution_logs updates → final status.
// ---------------------------------------------------------------------------
async function runStreamed(
  st: RunState,
  command: string,
  timeoutSec: number,
  label: string,
  pushTimeline: (e: any) => Promise<void>,
): Promise<{ result: sb.ExecResult; snapshotBefore: string | null; logId: string }> {
  const { db } = st;

  // Snapshot the workspace before every execution (rollback point).
  let snapshotBefore: string | null = null;
  try {
    const snap = await sb.snapshot(st.sandboxId!, `pre-${label}`);
    snapshotBefore = snap.id;
    await pushTimeline({ type: "snapshot", text: `snapshot ${snap.id.slice(0, 10)} (pre-${label})`, args: { snapshot: snap.id } });
  } catch { /* snapshot failure must not block execution */ }

  const { data: log } = await db.from("execution_logs").insert({
    user_id: st.userId, run_id: st.run.id, task_id: st.task.id,
    repository_id: st.repo?.id ?? null, command, status: "running",
    sandbox_id: st.sandboxId, started_at: new Date().toISOString(),
  }).select().single();
  await db.rpc("write_audit", {
    p_user_id: st.userId, p_action: "command_executed", p_resource_type: "execution_log",
    p_resource_id: log.id, p_metadata: { command: command.slice(0, 500) },
  });

  let outAcc = "";
  let errAcc = "";
  let pending = "";
  let lastFlush = Date.now();

  const flush = async (force = false) => {
    if (!pending) return;
    if (!force && Date.now() - lastFlush < 1500 && pending.length < 2048) return;
    const chunk = pending;
    pending = "";
    lastFlush = Date.now();
    await pushTimeline({ type: "log", tool: label, text: chunk.slice(0, 4000) });
    await db.from("execution_logs").update({
      stdout: outAcc.slice(0, 100_000), stderr: errAcc.slice(0, 100_000),
    }).eq("id", log.id);
  };

  const started = Date.now();
  let result: sb.ExecResult;
  try {
    result = await sb.execStreaming(st.sandboxId!, command, {
      timeoutSeconds: Math.min(timeoutSec, 600),
      jobKey: `${st.run.id}-${log.id}`,
      onChunk: async (stream, data) => {
        if (stream === "stdout") outAcc += data; else errAcc += data;
        pending += data;
        await flush();
      },
    });
  } catch (e) {
    await flush(true);
    await db.from("execution_logs").update({
      status: "failed", stderr: (errAcc + "\n" + String(e)).slice(0, 100_000),
      duration_ms: Date.now() - started, finished_at: new Date().toISOString(),
    }).eq("id", log.id);
    throw e;
  }

  await flush(true);
  await db.from("execution_logs").update({
    status: result.timed_out ? "timeout" : result.exit_code === 0 ? "success" : "failed",
    exit_code: result.exit_code,
    stdout: (result.stdout || outAcc).slice(0, 100_000),
    stderr: (result.stderr || errAcc).slice(0, 100_000),
    duration_ms: result.duration_ms || Date.now() - started,
    finished_at: new Date().toISOString(),
  }).eq("id", log.id);

  return { result, snapshotBefore, logId: log.id };
}

// ---------------------------------------------------------------------------
// Tool dispatch
// ---------------------------------------------------------------------------
async function dispatchTool(
  name: string,
  args: any,
  st: RunState,
  pushTimeline: (e: any) => Promise<void>,
): Promise<string> {
  const { db, userId, task, run, agent, repo, gh, branchName } = st;

  switch (name) {
    // --- code intelligence ----------------------------------------------------
    case "search_codebase": {
      let vec = null;
      if (st.ctx.embedKey) { try { vec = await embed(st.ctx.embedKey, args.query); } catch { /* trigram fallback */ } }
      const { data } = await db.rpc("search_repository_files", {
        p_repository_id: repo.id, p_query: args.query, p_query_embedding: vec, p_match_count: 12,
      });
      return JSON.stringify(data ?? []);
    }
    case "search_symbols": {
      const { data: defs } = await db.rpc("search_symbols", {
        p_repository_id: repo.id, p_query: args.name, p_kind: args.kind ?? null, p_match_count: 15,
      });
      const { data: refs } = await db.rpc("find_references", {
        p_repository_id: repo.id, p_symbol: args.name, p_match_count: 20,
      });
      return JSON.stringify({ definitions: defs ?? [], references: refs ?? [] });
    }
    case "dependency_graph": {
      const { data } = await db.rpc("file_dependency_graph", {
        p_repository_id: repo.id, p_path: args.path,
      });
      return JSON.stringify(data ?? {});
    }

    // --- reading ---------------------------------------------------------------
    case "read_file": {
      if (st.workspace) {
        const f = await sb.readFile(st.sandboxId!, args.path);
        return f.truncated ? `${f.content}\n[truncated — file is ${f.size} bytes]` : f.content;
      }
      if (st.staged.has(args.path)) return st.staged.get(args.path) ?? "(file staged for deletion)";
      const ref = st.branchCreated ? branchName : repo.default_branch;
      const content = await gh!.getFileContent(repo.full_name, args.path, ref);
      return content.slice(0, MAX_FILE_BYTES);
    }
    case "list_directory": {
      if (st.workspace) {
        const { files } = await sb.listFiles(st.sandboxId!, args.prefix || undefined);
        return JSON.stringify(files);
      }
      const { data } = await db.from("repository_files")
        .select("path, language, size_bytes")
        .eq("repository_id", repo.id)
        .like("path", `${(args.prefix ?? "").replace(/\/$/, "")}%`)
        .limit(200);
      return JSON.stringify(data ?? []);
    }

    // --- editing ----------------------------------------------------------------
    case "edit_file": {
      if (st.workspace) {
        const r = await sb.editFile(st.sandboxId!, args.path, args.old_str, args.new_str, args.replace_all ?? false);
        st.dirtySinceVerify = true;
        await pushTimeline({ type: "file_edit", text: args.path, preview: r.diff.slice(0, 1500) });
        return `Edited ${args.path} (${r.occurrences} occurrence(s)).\n${r.diff.slice(0, 4000)}`;
      }
      // Fallback: emulate exact-match replacement over staged/HEAD content.
      const ref = st.branchCreated ? branchName : repo.default_branch;
      const current = st.staged.has(args.path)
        ? (st.staged.get(args.path) ?? "")
        : await gh!.getFileContent(repo.full_name, args.path, ref);
      const count = current.split(args.old_str).length - 1;
      if (count === 0) return `ERROR: old_str not found in ${args.path}. Read the file and copy the exact text.`;
      if (count > 1 && !args.replace_all) return `ERROR: old_str appears ${count} times in ${args.path}. Add surrounding context to make it unique.`;
      st.staged.set(args.path, args.replace_all ? current.split(args.old_str).join(args.new_str) : current.replace(args.old_str, args.new_str));
      st.dirtySinceVerify = true;
      return `Staged edit to ${args.path} (${args.replace_all ? count : 1} occurrence(s)). Call commit_changes to persist.`;
    }
    case "create_file": {
      if (st.workspace) {
        try { await sb.readFile(st.sandboxId!, args.path); return `ERROR: ${args.path} already exists — use edit_file or write_file.`; }
        catch { /* good: doesn't exist */ }
        await sb.writeFile(st.sandboxId!, args.path, args.content);
        st.dirtySinceVerify = true;
        await pushTimeline({ type: "file_edit", text: `${args.path} (new)` });
        return `Created ${args.path} (${args.content.length} bytes).`;
      }
      st.staged.set(args.path, args.content);
      st.dirtySinceVerify = true;
      return `Staged new file ${args.path} (${args.content.length} bytes).`;
    }
    case "write_file": {
      if (st.workspace) {
        const r = await sb.writeFile(st.sandboxId!, args.path, args.content);
        st.dirtySinceVerify = true;
        await pushTimeline({ type: "file_edit", text: args.path, preview: r.diff.slice(0, 1500) });
        return `Wrote ${args.path} (${args.content.length} bytes, ${r.created ? "created" : "overwritten"}).`;
      }
      st.staged.set(args.path, args.content);
      st.dirtySinceVerify = true;
      return `Staged ${args.path} (${args.content.length} bytes). Call commit_changes to persist.`;
    }
    case "delete_file": {
      if (st.workspace) {
        await sb.deleteFile(st.sandboxId!, args.path);
        st.dirtySinceVerify = true;
        await pushTimeline({ type: "file_edit", text: `${args.path} (deleted)` });
        return `Deleted ${args.path}.`;
      }
      st.staged.set(args.path, null);
      st.dirtySinceVerify = true;
      return `Staged deletion of ${args.path}.`;
    }

    // --- execution --------------------------------------------------------------
    case "execute_command": {
      if (!st.workspace) return "ERROR: Command execution requires the sandbox runner (not configured).";
      const { result } = await runStreamed(st, args.command, args.timeout_seconds ?? 120, "exec", pushTimeline);
      return `exit=${result.exit_code}${result.timed_out ? " (TIMED OUT)" : ""}\nstdout:\n${result.stdout.slice(-8000)}\nstderr:\n${result.stderr.slice(-4000)}`;
    }
    case "run_build": {
      if (!st.workspace) return "ERROR: run_build requires the sandbox runner.";
      const cmds = await detectProjectCommands(st);
      const command = args.command || (cmds.install && cmds.build ? `${cmds.install} && ${cmds.build}` : cmds.build);
      if (!command) return "No build command detected (no package.json build script / Cargo.toml / go.mod). Pass an explicit command.";
      const { result } = await runStreamed(st, command, 600, "build", pushTimeline);
      return `build ${result.exit_code === 0 ? "PASSED" : "FAILED"} (exit=${result.exit_code})\n${result.stdout.slice(-6000)}\n${result.stderr.slice(-4000)}`;
    }
    case "run_tests": {
      if (!st.workspace) return "ERROR: run_tests requires the sandbox runner.";
      const cmds = await detectProjectCommands(st);
      const command = args.command || (cmds.test ? (cmds.install ? `${cmds.install} && ${cmds.test}` : cmds.test) : undefined);
      if (!command) return "No test command detected. Pass an explicit command (e.g. 'npx vitest run', 'python3 -m pytest').";
      const { result } = await runStreamed(st, command, 600, "test", pushTimeline);
      return `tests ${result.exit_code === 0 ? "PASSED" : "FAILED"} (exit=${result.exit_code})\n${result.stdout.slice(-6000)}\n${result.stderr.slice(-4000)}`;
    }

    // --- git ----------------------------------------------------------------------
    case "commit_changes": {
      if (st.workspace) {
        const d = await sb.diff(st.sandboxId!);
        if (!d.files.length) return "Nothing to commit — working tree clean.";
        const c = await sb.commit(st.sandboxId!, args.message, { name: `${agent.name} (CodePilot)`, email: "agent@codepilot.ai" });
        await sb.push(st.sandboxId!, branchName);
        st.pushed = true;
        await db.from("repository_branches").upsert({
          repository_id: repo.id, name: branchName, head_sha: c.sha, created_by_agent: true,
        }, { onConflict: "repository_id,name" });
        await db.from("commits").insert({
          repository_id: repo.id, task_id: task.id, run_id: run.id,
          sha: c.sha, branch: branchName, message: args.message,
          files_changed: d.files, additions: c.additions, deletions: c.deletions,
          github_url: `https://github.com/${repo.full_name}/commit/${c.sha}`,
        });
        return `Committed ${c.files_changed} file(s) as ${c.sha.slice(0, 7)} (+${c.additions}/−${c.deletions}) and pushed ${branchName}.`;
      }
      if (!st.staged.size) return "Nothing staged.";
      await ensureBranchFallback(st);
      const files = [...st.staged.entries()].map(([path, content]) => ({ path, content }));
      const commit = await gh!.commitFiles(repo.full_name, branchName, args.message, files);
      await db.from("commits").insert({
        repository_id: repo.id, task_id: task.id, run_id: run.id,
        sha: commit.sha, branch: branchName, message: args.message,
        files_changed: files.map((f) => ({ path: f.path, status: f.content === null ? "deleted" : "modified" })),
        github_url: commit.html_url,
      });
      st.staged.clear();
      st.pushed = true;
      return `Committed ${files.length} file(s): ${commit.sha.slice(0, 7)}`;
    }
    case "create_pull_request": {
      if (!st.pushed) {
        if (st.workspace) return "ERROR: Nothing pushed yet — call commit_changes first.";
        await ensureBranchFallback(st);
      }
      const pr = await gh!.createPullRequest(repo.full_name, {
        title: args.title, body: args.body, head: branchName, base: repo.default_branch,
      });
      const { data: row } = await db.from("pull_requests").insert({
        repository_id: repo.id, task_id: task.id, agent_id: agent.id, user_id: userId,
        github_pr_number: pr.number, title: args.title, body: args.body,
        head_branch: branchName, base_branch: repo.default_branch,
        files_changed: pr.changed_files ?? 0, additions: pr.additions ?? 0, deletions: pr.deletions ?? 0,
        risks: args.risks ?? [], testing_notes: args.testing_notes ?? null, github_url: pr.html_url,
      }).select().single();
      await db.from("agent_tasks").update({ pull_request_id: row.id }).eq("id", task.id);
      await db.rpc("write_audit", { p_user_id: userId, p_action: "pr_created", p_resource_type: "pull_request", p_resource_id: row.id, p_metadata: { pr_number: pr.number } });
      return `Opened PR #${pr.number}: ${pr.html_url}`;
    }

    // --- memory / plan / finish ----------------------------------------------------
    case "save_memory": {
      let embedding = null;
      if (st.ctx.embedKey) { try { embedding = await embed(st.ctx.embedKey, `${args.title}\n${args.content}`); } catch { /* store unembedded */ } }
      await db.from("agent_memories").insert({
        user_id: userId, agent_id: agent.id,
        repository_id: args.scope === "repository" ? repo?.id : null,
        task_id: args.scope === "task" ? task.id : null,
        scope: args.scope, category: args.category ?? "custom",
        title: args.title, content: args.content, embedding, source: "agent",
      });
      return "Memory saved.";
    }
    case "update_step": {
      const plan = task.plan;
      const step = plan?.steps?.find((s: any) => s.step === args.step);
      if (step) {
        step.status = args.status;
        await db.from("agent_tasks").update({ plan }).eq("id", task.id);
      }
      return `Step ${args.step} → ${args.status}`;
    }
    case "finish": {
      // Recorded here; the run loop decides whether verification gates it.
      st.finishArgs = { summary: args.summary, success: !!args.success };
      return st.workspace && st.dirtySinceVerify && st.agent.can_execute_commands
        ? "Finish requested — running verification (build/tests) before accepting."
        : "Task concluded.";
    }
    default:
      return `Unknown tool ${name}`;
  }
}

async function ensureBranchFallback(st: RunState) {
  if (st.branchCreated || !st.gh || !st.repo) return;
  const baseSha = await st.gh.getBranchSha(st.repo.full_name, st.repo.default_branch);
  await st.gh.createBranch(st.repo.full_name, st.branchName, baseSha);
  await st.db.from("repository_branches").upsert({
    repository_id: st.repo.id, name: st.branchName, head_sha: baseSha, created_by_agent: true,
  }, { onConflict: "repository_id,name" });
  st.branchCreated = true;
}

// ---------------------------------------------------------------------------
// action=chat
// ---------------------------------------------------------------------------
async function chatTurn(db: any, userId: string, body: any) {
  const { agentId, message } = body;
  const ctx = await loadAgentContext(db, userId, agentId);

  await db.from("agent_messages").insert({
    agent_id: agentId, user_id: userId, role: "user", content: message,
  });

  const { data: history } = await db.from("agent_messages")
    .select("role, content").eq("agent_id", agentId).eq("user_id", userId)
    .order("created_at", { ascending: false }).limit(24);
  const memories = await recallMemories(db, userId, ctx.repo?.id ?? null, message, ctx.embedKey);

  const result = await complete(ctx.providerCfg, [
    {
      role: "system",
      content: `You are ${ctx.agent.name}. ${ctx.agent.system_prompt}
Repository: ${ctx.repo?.full_name ?? "none"}.
Long-term memory:\n${memories.map((m: any) => `- ${m.title}: ${m.content}`).join("\n") || "(none)"}
If the user asks for a code change, suggest creating a task so you can plan and execute it.`,
    },
    ...(history ?? []).reverse().filter((m: any) => m.role === "user" || m.role === "assistant") as ChatMessage[],
  ], { temperature: ctx.agent.temperature });

  await db.rpc("record_usage", {
    p_user_id: userId, p_run_id: null, p_provider: ctx.providerCfg.provider,
    p_model: ctx.providerCfg.model, p_input: result.usage.inputTokens,
    p_output: result.usage.outputTokens,
    p_cost: estimateCost(ctx.providerCfg.model, result.usage.inputTokens, result.usage.outputTokens),
  });
  await db.from("agent_messages").insert({
    agent_id: agentId, user_id: userId, role: "assistant", content: result.text,
    input_tokens: result.usage.inputTokens, output_tokens: result.usage.outputTokens,
  });
  return json({ reply: result.text });
}

function slug(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
}
function summarizeArgs(call: { name: string; arguments: any }) {
  const a = { ...call.arguments };
  if (typeof a.content === "string") a.content = `${a.content.length} bytes`;
  if (typeof a.old_str === "string") a.old_str = `${a.old_str.length} chars`;
  if (typeof a.new_str === "string") a.new_str = `${a.new_str.length} chars`;
  return a;
}
