import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { PageHeader, MetricCard } from "@/components/page-header";
import { Badge, statusTone } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { UsageChart } from "./usage-chart";
import { formatTokens, formatUsd, timeAgo } from "@/lib/utils";
import { ArrowUpRight } from "lucide-react";

export default async function DashboardPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  const [{ data: metrics }, { data: recentTasks }, { data: recentPrs }] = await Promise.all([
    supabase.rpc("dashboard_metrics", { p_user_id: user!.id }),
    supabase
      .from("agent_tasks")
      .select("id, title, status, created_at, agents(name)")
      .order("created_at", { ascending: false })
      .limit(6),
    supabase
      .from("pull_requests")
      .select("id, title, status, github_pr_number, github_url, created_at, repositories(full_name)")
      .order("created_at", { ascending: false })
      .limit(6),
  ]);

  const m = metrics ?? {};

  return (
    <div className="animate-slideUp">
      <PageHeader title="Dashboard" description="Your agents, repositories, and usage at a glance." />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        <MetricCard label="Repositories" value={m.repositories ?? 0} />
        <MetricCard label="Active agents" value={m.active_agents ?? 0} />
        <MetricCard label="Pull requests" value={m.pull_requests ?? 0} sub={`${m.open_prs ?? 0} open`} />
        <MetricCard label="Tasks completed" value={m.tasks_completed ?? 0} sub={`${m.tasks_running ?? 0} running`} />
        <MetricCard label="Tokens this month" value={formatTokens(Number(m.tokens_month ?? 0))} />
        <MetricCard label="Cost this month" value={formatUsd(Number(m.cost_month ?? 0))} accent />
      </div>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Token usage — last 30 days</CardTitle>
        </CardHeader>
        <CardContent>
          <UsageChart series={(m.usage_series ?? []) as { day: string; tokens: number; cost: number }[]} />
        </CardContent>
      </Card>

      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Recent tasks</CardTitle>
            <Link href="/tasks" className="text-xs text-signal hover:underline">View all</Link>
          </CardHeader>
          <CardContent className="space-y-1 pt-3">
            {(recentTasks ?? []).length === 0 && (
              <p className="py-6 text-center text-sm text-faint">No tasks yet — create an agent and give it work.</p>
            )}
            {(recentTasks ?? []).map((t: any) => (
              <div key={t.id} className="flex items-center justify-between gap-3 rounded-md px-2 py-2 hover:bg-raised/60">
                <div className="min-w-0">
                  <p className="truncate text-sm">{t.title}</p>
                  <p className="text-[11px] text-faint">{t.agents?.name} · {timeAgo(t.created_at)}</p>
                </div>
                <Badge tone={statusTone(t.status)}>{t.status.replace(/_/g, " ")}</Badge>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Recent pull requests</CardTitle>
            <Link href="/pull-requests" className="text-xs text-signal hover:underline">View all</Link>
          </CardHeader>
          <CardContent className="space-y-1 pt-3">
            {(recentPrs ?? []).length === 0 && (
              <p className="py-6 text-center text-sm text-faint">No pull requests yet.</p>
            )}
            {(recentPrs ?? []).map((pr: any) => (
              <a
                key={pr.id}
                href={pr.github_url}
                target="_blank"
                rel="noreferrer"
                className="flex items-center justify-between gap-3 rounded-md px-2 py-2 hover:bg-raised/60"
              >
                <div className="min-w-0">
                  <p className="flex items-center gap-1 truncate text-sm">
                    {pr.title} <ArrowUpRight className="h-3 w-3 shrink-0 text-faint" />
                  </p>
                  <p className="font-mono text-[11px] text-faint">
                    {pr.repositories?.full_name} #{pr.github_pr_number}
                  </p>
                </div>
                <Badge tone={statusTone(pr.status)}>{pr.status}</Badge>
              </a>
            ))}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
