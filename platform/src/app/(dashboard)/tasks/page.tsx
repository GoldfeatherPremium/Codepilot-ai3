import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/page-header";
import { Badge, statusTone } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { timeAgo } from "@/lib/utils";
import { ListChecks } from "lucide-react";

export default async function TasksPage() {
  const supabase = await createClient();
  const { data: tasks } = await supabase
    .from("agent_tasks")
    .select("*, agents(id, name), repositories(full_name)")
    .order("created_at", { ascending: false })
    .limit(100);

  return (
    <div className="animate-slideUp">
      <PageHeader title="Tasks" description="Every plan an agent has proposed, with its execution status." />

      {(tasks ?? []).length === 0 && (
        <EmptyState
          icon={<ListChecks className="h-5 w-5" />}
          title="No tasks yet"
          description="Open an agent chat in Task mode and describe what you want built."
          actionLabel="Go to agents"
          actionHref="/agents"
        />
      )}

      {/* Mobile cards */}
      <div className="space-y-2 sm:hidden">
        {(tasks ?? []).map((t: any) => (
          <Link
            key={t.id}
            href={`/agents/${t.agents?.id}/chat`}
            className="block rounded-xl border border-line bg-surface p-4 transition-colors hover:bg-raised/60 active:bg-raised"
          >
            <div className="flex items-start justify-between gap-3">
              <p className="text-sm font-medium leading-snug">{t.title}</p>
              <Badge tone={statusTone(t.status)} className="shrink-0">{t.status.replace(/_/g, " ")}</Badge>
            </div>
            <p className="mt-2 text-[11px] text-faint">
              {t.agents?.name}
              {t.repositories?.full_name && <span className="font-mono"> · {t.repositories.full_name}</span>}
              {" · "}{timeAgo(t.created_at)}
            </p>
            {t.plan?.steps && (
              <p className="mt-1.5 font-mono text-[11px] text-muted">
                {t.plan.steps.filter((s: any) => s.status === "done").length}/{t.plan.steps.length} steps done
              </p>
            )}
          </Link>
        ))}
      </div>

      {/* Desktop table-style list */}
      <div className="hidden overflow-hidden rounded-xl border border-line sm:block">
        {(tasks ?? []).map((t: any, i: number) => (
          <Link
            key={t.id}
            href={`/agents/${t.agents?.id}/chat`}
            className={`flex min-h-[56px] items-center justify-between gap-4 bg-surface px-4 py-3 transition-colors hover:bg-raised/60 ${i > 0 ? "border-t border-line" : ""}`}
          >
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{t.title}</p>
              <p className="mt-0.5 truncate text-[11px] text-faint">
                {t.agents?.name}
                {t.repositories?.full_name && <span className="font-mono"> · {t.repositories.full_name}</span>}
                {t.branch_name && <span className="font-mono"> · {t.branch_name}</span>}
                {" · "}{timeAgo(t.created_at)}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-3">
              {t.plan?.steps && (
                <span className="font-mono text-[11px] text-faint">
                  {t.plan.steps.filter((s: any) => s.status === "done").length}/{t.plan.steps.length} steps
                </span>
              )}
              <Badge tone={statusTone(t.status)}>{t.status.replace(/_/g, " ")}</Badge>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
