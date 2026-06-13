import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/page-header";
import { Badge, statusTone } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SyncButton } from "./sync-button";
import { timeAgo } from "@/lib/utils";
import { ArrowUpRight, GitBranch, GitCommitHorizontal, Lock, Globe } from "lucide-react";

export default async function RepositoryPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();

  const { data: repo } = await supabase.from("repositories").select("*").eq("id", id).single();
  if (!repo) notFound();

  const [{ data: branches }, { data: commits }, { data: prs }] = await Promise.all([
    supabase.from("repository_branches").select("*").eq("repository_id", id).order("is_default", { ascending: false }).limit(20),
    supabase.from("commits").select("*").eq("repository_id", id).order("created_at", { ascending: false }).limit(15),
    supabase.from("pull_requests").select("*").eq("repository_id", id).order("created_at", { ascending: false }).limit(15),
  ]);

  const languages = Object.entries((repo.languages ?? {}) as Record<string, number>);
  const totalBytes = languages.reduce((s, [, b]) => s + b, 0) || 1;

  return (
    <div className="animate-slideUp">
      <PageHeader
        title={repo.full_name}
        description={repo.description ?? undefined}
      >
        <Badge tone={statusTone(repo.sync_status)}>{repo.sync_status}</Badge>
        <SyncButton repositoryId={repo.id} />
        <a href={repo.html_url} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-xs text-signal hover:underline">
          GitHub <ArrowUpRight className="h-3 w-3" />
        </a>
      </PageHeader>

      <div className="mb-6 flex flex-wrap items-center gap-x-5 gap-y-1 text-xs text-muted">
        <span className="flex items-center gap-1.5">
          {repo.private ? <Lock className="h-3.5 w-3.5" /> : <Globe className="h-3.5 w-3.5" />}
          {repo.private ? "Private" : "Public"}
        </span>
        <span className="font-mono">default: {repo.default_branch}</span>
        <span>{repo.indexed_file_count} files indexed</span>
        <span>{repo.last_synced_at ? `synced ${timeAgo(repo.last_synced_at)}` : "never synced"}</span>
      </div>

      {languages.length > 0 && (
        <Card className="mb-4">
          <CardContent className="py-4">
            <div className="flex h-2 overflow-hidden rounded-full">
              {languages.map(([lang, bytes], i) => (
                <div
                  key={lang}
                  title={lang}
                  style={{ width: `${(bytes / totalBytes) * 100}%`, opacity: 1 - i * 0.13 }}
                  className="bg-phosphor first:rounded-l-full last:rounded-r-full"
                />
              ))}
            </div>
            <div className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted">
              {languages.map(([lang, bytes]) => (
                <span key={lang}>
                  {lang} <span className="text-faint">{((bytes / totalBytes) * 100).toFixed(1)}%</span>
                </span>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>Branches</CardTitle></CardHeader>
          <CardContent className="space-y-1 pt-3">
            {(branches ?? []).length === 0 && <p className="py-4 text-center text-sm text-faint">Sync to load branches.</p>}
            {(branches ?? []).map((b: any) => (
              <div key={b.id} className="flex items-center justify-between gap-3 rounded-md px-2 py-1.5 hover:bg-raised/60">
                <span className="flex min-w-0 items-center gap-2 font-mono text-[13px]">
                  <GitBranch className="h-3.5 w-3.5 shrink-0 text-faint" />
                  <span className="truncate">{b.name}</span>
                  {b.is_default && <Badge>default</Badge>}
                  {b.created_by_agent && <Badge tone="phosphor">agent</Badge>}
                </span>
                <span className="font-mono text-[11px] text-faint">{b.head_sha.slice(0, 7)}</span>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Pull requests</CardTitle></CardHeader>
          <CardContent className="space-y-1 pt-3">
            {(prs ?? []).length === 0 && <p className="py-4 text-center text-sm text-faint">No pull requests yet.</p>}
            {(prs ?? []).map((pr: any) => (
              <a key={pr.id} href={pr.github_url ?? "#"} target="_blank" rel="noreferrer" className="flex items-center justify-between gap-3 rounded-md px-2 py-1.5 hover:bg-raised/60">
                <span className="min-w-0">
                  <span className="block truncate text-sm">{pr.title}</span>
                  <span className="font-mono text-[11px] text-faint">#{pr.github_pr_number} · {pr.head_branch} → {pr.base_branch}</span>
                </span>
                <Badge tone={statusTone(pr.status)}>{pr.status}</Badge>
              </a>
            ))}
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader><CardTitle>Recent commits</CardTitle></CardHeader>
          <CardContent className="space-y-1 pt-3">
            {(commits ?? []).length === 0 && <p className="py-4 text-center text-sm text-faint">Sync to load commit history.</p>}
            {(commits ?? []).map((c: any) => (
              <a key={c.id} href={c.github_url ?? "#"} target="_blank" rel="noreferrer" className="flex items-center justify-between gap-3 rounded-md px-2 py-1.5 hover:bg-raised/60">
                <span className="flex min-w-0 items-center gap-2.5">
                  <GitCommitHorizontal className="h-4 w-4 shrink-0 text-faint" />
                  <span className="truncate text-sm">{c.message.split("\n")[0]}</span>
                  {c.authored_by_agent && <Badge tone="phosphor">agent</Badge>}
                </span>
                <span className="shrink-0 font-mono text-[11px] text-faint">
                  {c.sha.slice(0, 7)} · {timeAgo(c.created_at)}
                </span>
              </a>
            ))}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
