"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Textarea } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Loader2 } from "lucide-react";

const DEFAULT_PROMPT = `You are a senior software engineer. Work carefully and incrementally:
- Read relevant files before changing anything.
- Follow the existing code style and architecture of the repository.
- Prefer small, reviewable changes. Explain trade-offs when they exist.
- Never invent APIs; verify against the codebase.`;

export default function NewAgentPage() {
  const router = useRouter();
  const [repos, setRepos] = useState<{ id: string; full_name: string }[]>([]);
  const [providers, setProviders] = useState<{ id: string; provider: string; default_model: string | null }[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [form, setForm] = useState({
    name: "",
    description: "",
    system_prompt: DEFAULT_PROMPT,
    model: "",
    repository_id: "",
    can_read_repo: true,
    can_edit_repo: true,
    can_create_commits: true,
    can_create_prs: true,
    can_execute_commands: false,
    max_iterations: 25,
  });

  useEffect(() => {
    const supabase = createClient();
    supabase.from("repositories").select("id, full_name").then(({ data }) => setRepos(data ?? []));
    supabase.from("provider_configs").select("id, provider, default_model, is_default")
      .then(({ data }) => {
        setProviders(data ?? []);
        const def = data?.find((p: any) => p.is_default);
        if (def?.default_model) setForm((f) => ({ ...f, model: f.model || def.default_model }));
      });
  }, []);

  async function save() {
    if (!form.name.trim() || !form.model.trim()) {
      setError("Name and model are required.");
      return;
    }
    setBusy(true);
    setError(null);
    const supabase = createClient();
    const { data: { user } } = await supabase.auth.getUser();
    const { data, error } = await supabase
      .from("agents")
      .insert({
        user_id: user!.id,
        name: form.name.trim(),
        description: form.description.trim() || null,
        system_prompt: form.system_prompt,
        model: form.model.trim(),
        repository_id: form.repository_id || null,
        can_read_repo: form.can_read_repo,
        can_edit_repo: form.can_edit_repo,
        can_create_commits: form.can_create_commits,
        can_create_prs: form.can_create_prs,
        can_execute_commands: form.can_execute_commands,
        max_iterations: form.max_iterations,
      })
      .select("id")
      .single();
    if (error) {
      setError(error.message);
      setBusy(false);
      return;
    }
    router.push(`/agents/${data.id}/chat`);
  }

  const set = (k: string, v: unknown) => setForm((f) => ({ ...f, [k]: v }));

  return (
    <div className="mx-auto max-w-2xl animate-slideUp">
      <PageHeader title="New agent" description="Permissions are enforced server-side on every tool call." />

      <Card>
        <CardHeader><CardTitle>Identity</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted">Name</label>
            <Input placeholder="e.g. Backend Engineer" value={form.name} onChange={(e) => set("name", e.target.value)} />
          </div>
          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted">Description</label>
            <Input placeholder="What this agent is for" value={form.description} onChange={(e) => set("description", e.target.value)} />
          </div>
          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted">System prompt</label>
            <Textarea rows={7} className="font-mono text-xs" value={form.system_prompt} onChange={(e) => set("system_prompt", e.target.value)} />
          </div>
        </CardContent>
      </Card>

      <Card className="mt-4">
        <CardHeader><CardTitle>Model & repository</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted">Model</label>
            <Input
              placeholder="e.g. claude-sonnet-4-6, gpt-4o, deepseek-chat"
              className="font-mono"
              value={form.model}
              onChange={(e) => set("model", e.target.value)}
            />
            {providers.length === 0 && (
              <p className="mt-1.5 text-[11px] text-warn">No AI provider configured yet — add one under AI Providers.</p>
            )}
          </div>
          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted">Repository</label>
            <select
              className="flex h-9 w-full rounded-md border border-line bg-raised px-3 text-sm focus:border-phosphor/50 focus:outline-none"
              value={form.repository_id}
              onChange={(e) => set("repository_id", e.target.value)}
            >
              <option value="">No repository (chat only)</option>
              {repos.map((r) => <option key={r.id} value={r.id}>{r.full_name}</option>)}
            </select>
          </div>
          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted">Max iterations per run</label>
            <Input
              type="number" min={5} max={100}
              value={form.max_iterations}
              onChange={(e) => set("max_iterations", Number(e.target.value) || 25)}
            />
          </div>
        </CardContent>
      </Card>

      <Card className="mt-4">
        <CardHeader><CardTitle>Permissions</CardTitle></CardHeader>
        <CardContent className="divide-y divide-line/60">
          <Switch checked={form.can_read_repo} onChange={(v) => set("can_read_repo", v)} label="Read repository" description="Search the codebase and read files" />
          <Switch checked={form.can_edit_repo} onChange={(v) => set("can_edit_repo", v)} label="Edit repository" description="Stage file edits and deletions on agent branches" />
          <Switch checked={form.can_create_commits} onChange={(v) => set("can_create_commits", v)} label="Create commits" description="Push staged changes as commits" />
          <Switch checked={form.can_create_prs} onChange={(v) => set("can_create_prs", v)} label="Create pull requests" description="Open PRs against the default branch" />
          <Switch checked={form.can_execute_commands} onChange={(v) => set("can_execute_commands", v)} label="Execute terminal commands" description="Run commands in an isolated sandbox (logged & audited)" />
        </CardContent>
      </Card>

      {error && <p className="mt-4 text-sm text-danger">{error}</p>}

      <div className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" onClick={() => router.back()}>Cancel</Button>
        <Button variant="phosphor" onClick={save} disabled={busy}>
          {busy && <Loader2 className="h-4 w-4 animate-spin" />} Create agent
        </Button>
      </div>
    </div>
  );
}
