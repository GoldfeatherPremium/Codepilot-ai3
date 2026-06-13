import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/page-header";
import { Badge, statusTone } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { timeAgo } from "@/lib/utils";
import { ArrowUpRight, GitPullRequest } from "lucide-react";

export default async function PullRequestsPage() {
  const supabase = await createClient();
  const { data: prs } = await supabase
    .from("pull_requests")
    .select("*, repositories(full_name), agents(name)")
    .order("created_at", { ascending: false })
    .limit(100);

  return (
    <div className="animate-slideUp">
      <PageHeader title="Pull Requests" description="PRs your agents have opened, with diff stats and review status." />

      {(prs ?? []).length === 0 && (
        <EmptyState
          icon={<GitPullRequest className="h-5 w-5" />}
          title="No pull requests yet"
          description="When an agent finishes an approved task with PR permission, the pull request appears here."
        />
      )}

      <div className="space-y-3">
        {(prs ?? []).map((pr: any) => (
          <a
            key={pr.id}
            href={pr.github_url ?? "#"}
            target="_blank"
            rel="noreferrer"
            className="block rounded-xl border border-line bg-surface p-4 transition-colors hover:border-faint/40"
          >
            <div className="flex items-start justify-between gap-3">
              <p className="flex min-w-0 items-center gap-1.5 text-sm font-medium">
                <GitPullRequest className="h-4 w-4 shrink-0 text-signal" />
                <span className="truncate">{pr.title}</span>
                <ArrowUpRight className="h-3 w-3 shrink-0 text-faint" />
              </p>
              <Badge tone={statusTone(pr.status)}>{pr.status}</Badge>
            </div>
            <p className="mt-1.5 font-mono text-[11px] text-faint">
              {pr.repositories?.full_name} #{pr.github_pr_number} · {pr.head_branch} → {pr.base_branch}
              {pr.agents?.name && ` · by ${pr.agents.name}`} · {timeAgo(pr.created_at)}
            </p>
            <div className="mt-2 flex items-center gap-4 font-mono text-[11px]">
              <span className="text-muted">{pr.files_changed} files</span>
              <span className="text-ok">+{pr.additions}</span>
              <span className="text-danger">−{pr.deletions}</span>
              {Array.isArray(pr.risks) && pr.risks.length > 0 && (
                <span className="text-warn">{pr.risks.length} risk{pr.risks.length > 1 ? "s" : ""} flagged</span>
              )}
            </div>
          </a>
        ))}
      </div>
    </div>
  );
}
