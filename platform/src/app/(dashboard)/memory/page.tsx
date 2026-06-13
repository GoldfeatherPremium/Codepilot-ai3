"use client";

import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { api } from "@/lib/api";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { Input, Textarea } from "@/components/ui/input";
import { timeAgo, cn } from "@/lib/utils";
import { Brain, Loader2, Pin, PinOff, Plus, Search, Trash2, X } from "lucide-react";

const CATEGORIES = [
  "coding_preference", "framework_preference", "architecture_preference",
  "project_structure", "previous_change", "important_file", "database_schema",
  "completed_task", "open_task", "conversation", "custom",
] as const;

interface MemoryRow {
  id: string;
  scope: "user" | "repository" | "task";
  category: string;
  title: string;
  content: string;
  pinned: boolean;
  created_at: string;
  similarity?: number;
  repositories?: { full_name: string } | null;
}

const scopeTone = (s: string): "signal" | "phosphor" | "neutral" => s === "user" ? "signal" : s === "repository" ? "phosphor" : "neutral";

export default function MemoryPage() {
  const [memories, setMemories] = useState<MemoryRow[] | null>(null);
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<string>("");
  const [category, setCategory] = useState<string>("");
  const [searching, setSearching] = useState(false);
  const [semantic, setSemantic] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const supabase = createClient();
    let q = supabase
      .from("agent_memories")
      .select("id, scope, category, title, content, pinned, created_at, repositories(full_name)")
      .order("pinned", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(100);
    if (scope) q = q.eq("scope", scope);
    if (category) q = q.eq("category", category);
    const { data } = await q;
    setMemories((data as unknown as MemoryRow[]) ?? []);
    setSemantic(false);
  }, [scope, category]);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { load(); }, [load]);

  async function semanticSearch() {
    if (!query.trim()) { load(); return; }
    setSearching(true);
    setError(null);
    try {
      const results = await api.memory.search(query.trim(), scope || undefined);
      setMemories(results as MemoryRow[]);
      setSemantic(true);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSearching(false);
    }
  }

  async function togglePin(m: MemoryRow) {
    const supabase = createClient();
    setMemories((ms) => ms?.map((x) => (x.id === m.id ? { ...x, pinned: !x.pinned } : x)) ?? null);
    await supabase.from("agent_memories").update({ pinned: !m.pinned }).eq("id", m.id);
  }

  async function setCat(m: MemoryRow, cat: string) {
    const supabase = createClient();
    setMemories((ms) => ms?.map((x) => (x.id === m.id ? { ...x, category: cat } : x)) ?? null);
    await supabase.from("agent_memories").update({ category: cat }).eq("id", m.id);
  }

  async function remove(m: MemoryRow) {
    if (!confirm("Delete this memory permanently?")) return;
    const supabase = createClient();
    setMemories((ms) => ms?.filter((x) => x.id !== m.id) ?? null);
    await supabase.from("agent_memories").delete().eq("id", m.id);
  }

  return (
    <div className="animate-slideUp">
      <PageHeader title="Memory" description="What your agents remember — searchable, pinnable, and fully under your control.">
        <Button variant="phosphor" size="sm" onClick={() => setCreating(true)}>
          <Plus className="h-4 w-4" /> Add memory
        </Button>
      </PageHeader>

      <div className="mb-5 flex flex-wrap items-center gap-2">
        <div className="relative min-w-56 flex-1">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-faint" />
          <Input
            className="pl-8"
            placeholder="Semantic search — e.g. “how do we handle auth?”"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && semanticSearch()}
          />
        </div>
        <select
          className="h-9 rounded-md border border-line bg-raised px-2.5 text-sm focus:border-phosphor/50 focus:outline-none"
          value={scope} onChange={(e) => setScope(e.target.value)}
        >
          <option value="">All scopes</option>
          <option value="user">User</option>
          <option value="repository">Repository</option>
          <option value="task">Task</option>
        </select>
        <select
          className="h-9 rounded-md border border-line bg-raised px-2.5 text-sm focus:border-phosphor/50 focus:outline-none"
          value={category} onChange={(e) => setCategory(e.target.value)}
        >
          <option value="">All categories</option>
          {CATEGORIES.map((c) => <option key={c} value={c}>{c.replace(/_/g, " ")}</option>)}
        </select>
        <Button variant="outline" size="sm" onClick={semanticSearch} disabled={searching}>
          {searching ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Search"}
        </Button>
        {semantic && (
          <Button variant="ghost" size="sm" onClick={load}><X className="h-3.5 w-3.5" /> Clear</Button>
        )}
      </div>

      {error && <p className="mb-4 text-sm text-danger">{error}</p>}

      {memories && memories.length === 0 && (
        <EmptyState
          icon={<Brain className="h-5 w-5" />}
          title={semantic ? "No matching memories" : "No memories yet"}
          description={semantic ? "Try a different query or clear the search." : "Agents save memories as they work; you can also add them manually."}
        />
      )}

      <div className="space-y-3">
        {memories === null && <p className="text-sm text-faint">Loading…</p>}
        {memories?.map((m) => (
          <div key={m.id} className={cn("rounded-xl border bg-surface p-4", m.pinned ? "border-phosphor/30" : "border-line")}>
            <div className="flex items-start justify-between gap-3">
              <p className="flex min-w-0 items-center gap-2 text-sm font-medium">
                {m.pinned && <Pin className="h-3.5 w-3.5 shrink-0 text-phosphor" />}
                <span className="truncate">{m.title}</span>
              </p>
              <div className="flex shrink-0 items-center gap-1">
                <button onClick={() => togglePin(m)} title={m.pinned ? "Unpin" : "Pin (boosts recall)"} className="rounded p-1.5 text-faint hover:bg-raised hover:text-phosphor">
                  {m.pinned ? <PinOff className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />}
                </button>
                <button onClick={() => remove(m)} title="Delete" className="rounded p-1.5 text-faint hover:bg-raised hover:text-danger">
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
            <p className="mt-1.5 whitespace-pre-wrap text-[13px] leading-relaxed text-muted">{m.content}</p>
            <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px] text-faint">
              <Badge tone={scopeTone(m.scope)}>{m.scope}</Badge>
              <select
                className="rounded border border-line bg-raised px-1.5 py-0.5 text-[11px] text-muted focus:outline-none"
                value={m.category}
                onChange={(e) => setCat(m, e.target.value)}
              >
                {CATEGORIES.map((c) => <option key={c} value={c}>{c.replace(/_/g, " ")}</option>)}
              </select>
              {m.repositories?.full_name && <span className="font-mono">{m.repositories.full_name}</span>}
              {typeof m.similarity === "number" && (
                <span className="font-mono text-phosphor">{(m.similarity * 100).toFixed(0)}% match</span>
              )}
              <span className="ml-auto">{timeAgo(m.created_at)}</span>
            </div>
          </div>
        ))}
      </div>

      {creating && <CreateMemoryDialog onClose={() => setCreating(false)} onCreated={load} />}
    </div>
  );
}

function CreateMemoryDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [repos, setRepos] = useState<{ id: string; full_name: string }[]>([]);
  const [form, setForm] = useState({ scope: "user", category: "custom", title: "", content: "", repositoryId: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    createClient().from("repositories").select("id, full_name").then(({ data }) => setRepos(data ?? []));
  }, []);

  async function save() {
    if (!form.title.trim() || !form.content.trim()) { setError("Title and content are required."); return; }
    if (form.scope === "repository" && !form.repositoryId) { setError("Pick a repository for repository-scoped memories."); return; }
    setBusy(true);
    setError(null);
    try {
      await api.memory.create({
        scope: form.scope,
        category: form.category,
        title: form.title.trim(),
        content: form.content.trim(),
        repositoryId: form.scope === "repository" ? form.repositoryId : undefined,
      });
      onCreated();
      onClose();
    } catch (e: any) {
      setError(e.message);
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6" onClick={onClose}>
      <div className="w-full max-w-md animate-slideUp rounded-xl border border-line bg-surface p-5" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-sm font-semibold">Add memory</h2>
        <div className="mt-4 space-y-3">
          <Input placeholder="Title" value={form.title} onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))} />
          <Textarea rows={4} placeholder="What should agents remember?" value={form.content} onChange={(e) => setForm((f) => ({ ...f, content: e.target.value }))} />
          <div className="flex gap-2">
            <select className="h-9 flex-1 rounded-md border border-line bg-raised px-2.5 text-sm focus:outline-none"
              value={form.scope} onChange={(e) => setForm((f) => ({ ...f, scope: e.target.value }))}>
              <option value="user">User scope</option>
              <option value="repository">Repository scope</option>
            </select>
            <select className="h-9 flex-1 rounded-md border border-line bg-raised px-2.5 text-sm focus:outline-none"
              value={form.category} onChange={(e) => setForm((f) => ({ ...f, category: e.target.value }))}>
              {CATEGORIES.map((c) => <option key={c} value={c}>{c.replace(/_/g, " ")}</option>)}
            </select>
          </div>
          {form.scope === "repository" && (
            <select className="h-9 w-full rounded-md border border-line bg-raised px-2.5 text-sm focus:outline-none"
              value={form.repositoryId} onChange={(e) => setForm((f) => ({ ...f, repositoryId: e.target.value }))}>
              <option value="">Select repository…</option>
              {repos.map((r) => <option key={r.id} value={r.id}>{r.full_name}</option>)}
            </select>
          )}
        </div>
        {error && <p className="mt-3 text-xs text-danger">{error}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
          <Button variant="phosphor" size="sm" onClick={save} disabled={busy}>
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Save
          </Button>
        </div>
      </div>
    </div>
  );
}
