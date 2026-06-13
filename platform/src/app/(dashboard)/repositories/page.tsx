"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { api } from "@/lib/api";
import type { Repository } from "@/lib/types";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Badge, statusTone } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { timeAgo } from "@/lib/utils";
import { FolderGit2, Lock, Globe, Loader2, Plus, RefreshCw, Star, X } from "lucide-react";

export default function RepositoriesPage() {
  const [repos, setRepos] = useState<Repository[] | null>(null);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const supabase = createClient();
    const { data } = await supabase
      .from("repositories")
      .select("*")
      .order("created_at", { ascending: false });
    setRepos((data as Repository[]) ?? []);
  }, []);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { load(); }, [load]);

  async function sync(id: string) {
    setError(null);
    setRepos((r) => r?.map((x) => (x.id === id ? { ...x, sync_status: "syncing" } : x)) ?? null);
    try {
      await api.github.sync(id);
      // sync runs in the background; poll once after a delay
      setTimeout(load, 4000);
    } catch (e: any) {
      setError(e.message);
      load();
    }
  }

  return (
    <div className="animate-slideUp">
      <PageHeader title="Repositories" description="Connected GitHub repositories your agents can work on.">
        <Button variant="phosphor" size="sm" onClick={() => setImporting(true)}>
          <Plus className="h-4 w-4" /> Import repository
        </Button>
      </PageHeader>

      {error && <p className="mb-4 text-sm text-danger">{error}</p>}

      {repos && repos.length === 0 && (
        <EmptyState
          icon={<FolderGit2 className="h-5 w-5" />}
          title="No repositories connected"
          description="Import a GitHub repository so agents can read, edit, and open pull requests against it."
        />
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        {repos === null && <p className="text-sm text-faint">Loading…</p>}
        {repos?.map((r) => (
          <div key={r.id} className="group rounded-xl border border-line bg-surface p-4 transition-colors hover:border-faint/40">
            <div className="flex items-start justify-between gap-3">
              <Link href={`/repositories/${r.id}`} className="min-w-0 flex-1">
                <p className="flex items-center gap-2 font-mono text-sm font-medium group-hover:text-phosphor">
                  {r.private ? <Lock className="h-3.5 w-3.5 shrink-0 text-faint" /> : <Globe className="h-3.5 w-3.5 shrink-0 text-faint" />}
                  <span className="truncate">{r.full_name}</span>
                </p>
                {r.description && <p className="mt-1 line-clamp-2 text-xs text-muted">{r.description}</p>}
              </Link>
              <div className="flex shrink-0 items-center gap-2">
                <Badge tone={statusTone(r.sync_status)}>{r.sync_status}</Badge>
                <button
                  onClick={() => sync(r.id)}
                  disabled={r.sync_status === "syncing"}
                  title="Sync now"
                  className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-raised hover:text-ink disabled:opacity-50"
                  aria-label="Sync repository"
                >
                  <RefreshCw className={`h-3.5 w-3.5 ${r.sync_status === "syncing" ? "animate-spin" : ""}`} />
                </button>
              </div>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-faint">
              <span className="flex items-center gap-1"><Star className="h-3 w-3" />{r.stars}</span>
              {Object.keys(r.languages ?? {}).slice(0, 3).length > 0 && (
                <span>{Object.keys(r.languages ?? {}).slice(0, 3).join(" · ")}</span>
              )}
              <span>{r.indexed_file_count ?? 0} files</span>
              <span className="ml-auto">{r.last_synced_at ? `synced ${timeAgo(r.last_synced_at)}` : "never synced"}</span>
            </div>
          </div>
        ))}
      </div>

      {importing && <ImportDialog onClose={() => setImporting(false)} onImported={load} />}
    </div>
  );
}

function ImportDialog({ onClose, onImported }: { onClose: () => void; onImported: () => void }) {
  const [remote, setRemote] = useState<any[] | null>(null);
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.github.listRemote()
      .then(setRemote)
      .catch((e) => setError(e.message));
  }, []);

  async function doImport(fullName: string) {
    setBusy(fullName);
    setError(null);
    try {
      const { repositoryId } = await api.github.import(fullName);
      await api.github.sync(repositoryId).catch(() => {});
      onImported();
      onClose();
    } catch (e: any) {
      setError(e.message);
      setBusy(null);
    }
  }

  const list = (remote ?? []).filter((r) => r.full_name.toLowerCase().includes(filter.toLowerCase()));

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-0 sm:items-center sm:p-6" onClick={onClose}>
      <div
        className="flex max-h-[85vh] w-full animate-slideUp flex-col rounded-t-2xl border border-line bg-surface sm:max-h-[70vh] sm:max-w-lg sm:rounded-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-line p-4">
          <h2 className="text-sm font-semibold">Import from GitHub</h2>
          <button onClick={onClose} className="rounded p-1 text-faint hover:bg-raised hover:text-ink">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="border-b border-line p-3">
          <Input placeholder="Filter repositories…" value={filter} onChange={(e) => setFilter(e.target.value)} autoFocus />
        </div>
        <div className="flex-1 overflow-y-auto p-2">
          {error && <p className="p-3 text-sm text-danger">{error}</p>}
          {remote === null && !error && (
            <p className="flex items-center justify-center gap-2 py-10 text-sm text-faint">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading your GitHub repositories…
            </p>
          )}
          {list.map((r) => (
            <div key={r.github_repo_id} className="flex items-center justify-between gap-3 rounded-md px-2.5 py-2 hover:bg-raised/60">
              <div className="min-w-0">
                <p className="truncate font-mono text-[13px]">{r.full_name}</p>
                {r.description && <p className="truncate text-xs text-faint">{r.description}</p>}
              </div>
              <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => doImport(r.full_name)}>
                {busy === r.full_name ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Import"}
              </Button>
            </div>
          ))}
          {remote !== null && list.length === 0 && !error && (
            <p className="py-8 text-center text-sm text-faint">No repositories match.</p>
          )}
        </div>
      </div>
    </div>
  );
}
