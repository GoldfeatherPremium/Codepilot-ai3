"use client";

import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { api } from "@/lib/api";
import type { ProviderConfigRow } from "@/lib/types";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Badge, statusTone } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { timeAgo } from "@/lib/utils";
import { CheckCircle2, KeyRound, Loader2, Plus, Star, Trash2, X, Zap } from "lucide-react";

const PROVIDERS: { id: string; name: string; placeholderModel: string; needsEndpoint?: boolean; needsRegion?: boolean }[] = [
  { id: "openai", name: "OpenAI", placeholderModel: "gpt-4o" },
  { id: "anthropic", name: "Anthropic", placeholderModel: "claude-sonnet-4-6" },
  { id: "gemini", name: "Google Gemini", placeholderModel: "gemini-2.0-flash" },
  { id: "deepseek", name: "DeepSeek", placeholderModel: "deepseek-chat" },
  { id: "openrouter", name: "OpenRouter", placeholderModel: "anthropic/claude-sonnet-4" },
  { id: "groq", name: "Groq", placeholderModel: "llama-3.3-70b-versatile" },
  { id: "together", name: "Together AI", placeholderModel: "meta-llama/Llama-3.3-70B-Instruct-Turbo" },
  { id: "fireworks", name: "Fireworks", placeholderModel: "accounts/fireworks/models/llama-v3p1-70b-instruct" },
  { id: "azure_openai", name: "Azure OpenAI", placeholderModel: "gpt-4o (deployment name)", needsEndpoint: true },
  { id: "aws_bedrock", name: "AWS Bedrock", placeholderModel: "anthropic.claude-sonnet-4-v1:0", needsRegion: true },
  { id: "vertex_ai", name: "Vertex AI", placeholderModel: "gemini-2.0-flash", needsEndpoint: true },
  { id: "cohere", name: "Cohere", placeholderModel: "command-r-plus" },
  { id: "mistral", name: "Mistral", placeholderModel: "mistral-large-latest" },
  { id: "qwen", name: "Qwen (DashScope)", placeholderModel: "qwen-max" },
];

export default function ProvidersPage() {
  const [configs, setConfigs] = useState<ProviderConfigRow[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data } = await createClient()
      .from("provider_configs")
      .select("id, provider, label, key_last4, default_model, is_default, status, last_tested_at")
      .order("created_at", { ascending: false });
    setConfigs((data as ProviderConfigRow[]) ?? []);
  }, []);

  useEffect(() => { load(); }, [load]);

  async function test(id: string) {
    setBusyId(id);
    setError(null);
    try {
      const r = await api.providers.test(id);
      if (r.error) setError(r.error);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusyId(null);
      load();
    }
  }

  async function setDefault(id: string) {
    setBusyId(id);
    try { await api.providers.setDefault(id); } catch (e: any) { setError(e.message); }
    setBusyId(null);
    load();
  }

  async function remove(id: string) {
    if (!confirm("Remove this provider key? Agents using it will stop working.")) return;
    setBusyId(id);
    try { await api.providers.remove(id); } catch (e: any) { setError(e.message); }
    setBusyId(null);
    load();
  }

  const nameOf = (p: string) => PROVIDERS.find((x) => x.id === p)?.name ?? p;

  return (
    <div className="animate-slideUp">
      <PageHeader title="AI Providers" description="Bring your own keys. Stored with AES-256-GCM — only the last 4 characters are ever shown.">
        <Button variant="phosphor" size="sm" onClick={() => setAdding(true)}>
          <Plus className="h-4 w-4" /> Add provider
        </Button>
      </PageHeader>

      {error && <p className="mb-4 text-sm text-danger">{error}</p>}

      {configs && configs.length === 0 && (
        <EmptyState
          icon={<KeyRound className="h-5 w-5" />}
          title="No providers configured"
          description="Add at least one API key. An OpenAI key also unlocks semantic code search and memory embeddings."
        />
      )}

      <div className="space-y-3">
        {configs?.map((c) => (
          <div key={c.id} className="flex flex-wrap items-center gap-3 rounded-xl border border-line bg-surface p-4">
            <div className="min-w-0 flex-1">
              <p className="flex items-center gap-2 text-sm font-medium">
                {c.label || nameOf(c.provider)}
                {c.is_default && <Badge tone="phosphor"><Star className="h-2.5 w-2.5" /> default</Badge>}
              </p>
              <p className="mt-0.5 font-mono text-[11px] text-faint">
                {nameOf(c.provider)} · ••••{c.key_last4}
                {c.default_model && ` · ${c.default_model}`}
                {c.last_tested_at && ` · tested ${timeAgo(c.last_tested_at)}`}
              </p>
            </div>
            <Badge tone={statusTone(c.status)}>{c.status.replace(/_/g, " ")}</Badge>
            <div className="flex items-center gap-1">
              <Button variant="outline" size="sm" onClick={() => test(c.id)} disabled={busyId !== null}>
                {busyId === c.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Zap className="h-3.5 w-3.5" />} Test
              </Button>
              {!c.is_default && (
                <Button variant="ghost" size="sm" onClick={() => setDefault(c.id)} disabled={busyId !== null} title="Set as default">
                  <CheckCircle2 className="h-3.5 w-3.5" /> Default
                </Button>
              )}
              <button onClick={() => remove(c.id)} disabled={busyId !== null} title="Delete key" className="rounded p-1.5 text-faint hover:bg-raised hover:text-danger disabled:opacity-50">
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        ))}
      </div>

      {adding && <AddProviderDialog onClose={() => setAdding(false)} onAdded={load} />}
    </div>
  );
}

function AddProviderDialog({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const [form, setForm] = useState({
    provider: "anthropic", label: "", apiKey: "", endpointUrl: "", region: "", defaultModel: "", isDefault: true,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const meta = PROVIDERS.find((p) => p.id === form.provider)!;

  async function save() {
    if (!form.apiKey.trim()) { setError("API key is required."); return; }
    setBusy(true);
    setError(null);
    try {
      await api.providers.add({
        provider: form.provider,
        label: form.label.trim() || undefined,
        apiKey: form.apiKey.trim(),
        endpointUrl: form.endpointUrl.trim() || undefined,
        region: form.region.trim() || undefined,
        defaultModel: form.defaultModel.trim() || undefined,
        isDefault: form.isDefault,
      });
      onAdded();
      onClose();
    } catch (e: any) {
      setError(e.message);
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6" onClick={onClose}>
      <div className="w-full max-w-md animate-slideUp rounded-xl border border-line bg-surface p-5" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">Add AI provider</h2>
          <button onClick={onClose} className="rounded p-1 text-faint hover:bg-raised hover:text-ink"><X className="h-4 w-4" /></button>
        </div>
        <div className="mt-4 space-y-3">
          <select
            className="h-9 w-full rounded-md border border-line bg-raised px-2.5 text-sm focus:border-phosphor/50 focus:outline-none"
            value={form.provider}
            onChange={(e) => setForm((f) => ({ ...f, provider: e.target.value }))}
          >
            {PROVIDERS.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <Input placeholder="Label (optional, e.g. “work key”)" value={form.label} onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))} />
          <Input
            type="password"
            placeholder={form.provider === "aws_bedrock" ? "ACCESS_KEY_ID:SECRET_ACCESS_KEY" : "API key"}
            className="font-mono"
            value={form.apiKey}
            onChange={(e) => setForm((f) => ({ ...f, apiKey: e.target.value }))}
          />
          {meta.needsEndpoint && (
            <Input placeholder={form.provider === "azure_openai" ? "https://YOUR-RESOURCE.openai.azure.com" : "Project endpoint / project ID"} value={form.endpointUrl} onChange={(e) => setForm((f) => ({ ...f, endpointUrl: e.target.value }))} />
          )}
          {meta.needsRegion && (
            <Input placeholder="Region, e.g. us-east-1" value={form.region} onChange={(e) => setForm((f) => ({ ...f, region: e.target.value }))} />
          )}
          <Input placeholder={`Default model, e.g. ${meta.placeholderModel}`} className="font-mono" value={form.defaultModel} onChange={(e) => setForm((f) => ({ ...f, defaultModel: e.target.value }))} />
          <label className="flex cursor-pointer items-center gap-2 text-sm text-muted">
            <input type="checkbox" checked={form.isDefault} onChange={(e) => setForm((f) => ({ ...f, isDefault: e.target.checked }))} className="accent-[hsl(38_96%_56%)]" />
            Make this my default provider
          </label>
        </div>
        {error && <p className="mt-3 text-xs text-danger">{error}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
          <Button variant="phosphor" size="sm" onClick={save} disabled={busy}>
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Save & verify
          </Button>
        </div>
      </div>
    </div>
  );
}
