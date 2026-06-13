// Hand-maintained app types. Regenerate full DB types with `npm run db:types`.

export type TaskStatus =
  | "pending" | "planning" | "awaiting_approval" | "approved" | "running"
  | "completed" | "failed" | "cancelled" | "rejected";

export type Provider =
  | "openai" | "anthropic" | "gemini" | "deepseek" | "openrouter" | "groq"
  | "together" | "fireworks" | "azure_openai" | "aws_bedrock" | "vertex_ai"
  | "cohere" | "mistral" | "qwen";

export interface PlanStep {
  step: number;
  title: string;
  detail: string;
  status: "pending" | "running" | "done" | "failed";
}

export interface Agent {
  id: string;
  name: string;
  description: string | null;
  system_prompt: string;
  model: string;
  repository_id: string | null;
  can_read_repo: boolean;
  can_edit_repo: boolean;
  can_create_commits: boolean;
  can_create_prs: boolean;
  can_execute_commands: boolean;
  is_archived: boolean;
  created_at: string;
  repositories?: Repository | null;
}

export interface Repository {
  id: string;
  full_name: string;
  name: string;
  description: string | null;
  private: boolean;
  default_branch: string;
  languages: Record<string, number>;
  stars: number;
  sync_status: "never" | "syncing" | "synced" | "error";
  last_synced_at: string | null;
  indexed_file_count: number;
  html_url: string;
}

export interface AgentTask {
  id: string;
  agent_id: string;
  title: string;
  prompt: string;
  status: TaskStatus;
  plan: { title: string; steps: PlanStep[] } | null;
  result_summary: string | null;
  error: string | null;
  branch_name: string | null;
  created_at: string;
  completed_at: string | null;
}

export interface AgentMessage {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  parts: Array<Record<string, unknown>>;
  created_at: string;
  task_id: string | null;
  run_id: string | null;
}

export interface TimelineEvent {
  at: string;
  type: "thinking" | "tool_call" | "tool_result" | "plan" | "file_edit" | "log" | "snapshot" | "repair";
  tool?: string;
  text?: string;
  preview?: string;
  args?: Record<string, unknown>;
}

export interface Memory {
  id: string;
  scope: "user" | "repository" | "task";
  category: string;
  title: string;
  content: string;
  pinned: boolean;
  created_at: string;
  similarity?: number;
}

export interface ProviderConfigRow {
  id: string;
  provider: Provider;
  label: string;
  key_last4: string;
  default_model: string | null;
  is_default: boolean;
  status: "unverified" | "active" | "invalid" | "rate_limited";
  last_tested_at: string | null;
}
