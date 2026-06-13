import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { PageHeader, MetricCard } from "@/components/page-header";
import { Badge, statusTone } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatTokens, formatUsd, timeAgo } from "@/lib/utils";

export default async function AdminPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  const { data: profile } = await supabase.from("users").select("role").eq("id", user!.id).single();
  if (profile?.role !== "admin") redirect("/dashboard");

  const [{ data: metrics }, { data: audit }] = await Promise.all([
    supabase.rpc("admin_metrics"),
    supabase.from("audit_logs").select("*").order("created_at", { ascending: false }).limit(30),
  ]);

  const m = metrics ?? {};

  return (
    <div className="animate-slideUp">
      <PageHeader title="Admin" description="System-wide metrics and the audit trail. Visible to admins only." />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard label="Total users" value={m.total_users ?? 0} />
        <MetricCard label="Total repositories" value={m.total_repos ?? 0} />
        <MetricCard label="Runs today" value={m.runs_today ?? 0} sub={`${m.runs_failed_today ?? 0} failed`} />
        <MetricCard label="Live runs" value={m.running_runs ?? 0} sub={`${m.queued_runs ?? 0} queued`} accent />
        <MetricCard label="Tokens today" value={formatTokens(Number(m.tokens_today ?? 0))} />
        <MetricCard label="Revenue this month" value={formatUsd(Number(m.revenue_month ?? 0))} accent />
      </div>

      <Card className="mt-6">
        <CardHeader><CardTitle>Audit log</CardTitle></CardHeader>
        <CardContent className="pt-3">
          {(audit ?? []).length === 0 && <p className="py-6 text-center text-sm text-faint">No audit entries.</p>}
          <div className="divide-y divide-line/60">
            {(audit ?? []).map((a: any) => (
              <div key={a.id} className="flex items-center justify-between gap-4 py-2">
                <div className="min-w-0">
                  <p className="flex items-center gap-2 text-[13px]">
                    <Badge tone={statusTone(a.action.includes("deleted") || a.action.includes("rejected") ? "failed" : "completed")}>
                      {a.action.replace(/_/g, " ")}
                    </Badge>
                    <span className="truncate font-mono text-[11px] text-faint">
                      {a.resource_type}{a.resource_id ? ` · ${String(a.resource_id).slice(0, 8)}` : ""}
                    </span>
                  </p>
                </div>
                <span className="shrink-0 text-[11px] text-faint">{timeAgo(a.created_at)}</span>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
