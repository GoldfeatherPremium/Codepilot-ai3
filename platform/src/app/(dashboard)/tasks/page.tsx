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

      <div className="overflow-hidden rounded-xl border border-line">
        {(tasks ?? []).map((t: any, i: number) => (
          <Link
            key={t.id}
            href={`/agents/${t.agents?.id}/chat`}
            className={`flex items-center justify-between gap-4 bg-surface px-4 py-3 transition-colors hover:bg-raised/60 ${i > 0 ? "border-t border-line" : ""}`}
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
