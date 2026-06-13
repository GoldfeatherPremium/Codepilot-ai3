// Typed wrappers around edge functions.
import { createClient } from "@/lib/supabase/client";

async function invoke<T>(fn: string, body: Record<string, unknown>): Promise<T> {
  const supabase = createClient();
  const { data, error } = await supabase.functions.invoke(fn, { body });
  if (error) {
    let msg = error.message;
    try {
      const ctx = await (error as any).context?.json?.();
      if (ctx?.error) msg = ctx.error;
    } catch { /* keep generic message */ }
    throw new Error(msg);
  }
  return data as T;
}

function newMsgId() {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
}

export const api = {
  github: {
    listRemote: (page = 1) => invoke<any[]>("github-sync", { action: "list_remote", page }),
    import: (fullName: string) => invoke<{ repositoryId: string }>("github-sync", { action: "import", fullName }),
    sync: (repositoryId: string) => invoke<{ status: string }>("github-sync", { action: "sync", repositoryId }),
  },
  providers: {
    add: (p: { provider: string; label?: string; apiKey: string; endpointUrl?: string; region?: string; defaultModel?: string; isDefault?: boolean }) =>
      invoke("provider-test", { action: "add", ...p }),
    test: (configId: string, model?: string) => invoke<{ status: string; error?: string }>("provider-test", { action: "test", configId, model }),
    setDefault: (configId: string) => invoke("provider-test", { action: "set_default", configId }),
    remove: (configId: string) => invoke("provider-test", { action: "delete", configId }),
  },
  agent: {
    plan: (agentId: string, prompt: string) =>
      invoke<{ taskId: string; plan: any }>("agent-run", { action: "plan", agentId, prompt, clientMsgId: newMsgId() }),
    approve: (taskId: string) => invoke<{ runId: string }>("agent-run", { action: "approve", taskId }),
    reject: (taskId: string, reason?: string) => invoke("agent-run", { action: "reject", taskId, reason }),
    chat: (agentId: string, message: string) =>
      invoke<{ reply: string }>("agent-run", { action: "chat", agentId, message, clientUserMsgId: newMsgId(), clientAsstMsgId: newMsgId() }),
  },
  memory: {
    create: (m: { scope: string; category?: string; title: string; content: string; repositoryId?: string }) =>
      invoke("memory-embed", { action: "create", ...m }),
    search: (query: string, scope?: string) => invoke<any[]>("memory-embed", { action: "search", query, scope }),
  },
};
