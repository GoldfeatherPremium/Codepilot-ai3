import { createClient } from "@/lib/supabase/server";
import { PageHeader, MetricCard } from "@/components/page-header";
import { Badge, statusTone } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatTokens, formatUsd } from "@/lib/utils";
import { cn } from "@/lib/utils";

const PLANS = [
  { id: "free", name: "Free", price: "$0", blurb: "2 repositories · 1 agent · 200k tokens/mo" },
  { id: "pro", name: "Pro", price: "$20", blurb: "Unlimited repos · 10 agents · 5M tokens/mo · sandbox exec" },
  { id: "team", name: "Team", price: "$60", blurb: "Everything in Pro · shared agents · priority runs · SSO" },
  { id: "enterprise", name: "Enterprise", price: "Custom", blurb: "Dedicated infra · audit export · custom providers · SLA" },
];

export default async function BillingPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  const [{ data: profile }, { data: records }, { data: usage }] = await Promise.all([
    supabase.from("users").select("plan").eq("id", user!.id).single(),
    supabase.from("billing_records").select("*").order("period_start", { ascending: false }).limit(12),
    supabase.rpc("dashboard_metrics", { p_user_id: user!.id }),
  ]);

  const plan = profile?.plan ?? "free";

  return (
    <div className="animate-slideUp">
      <PageHeader title="Billing" description="Plan, current usage, and invoice history." />

      <div className="grid gap-3 sm:grid-cols-3">
        <MetricCard label="Current plan" value={plan.toUpperCase()} />
        <MetricCard label="Tokens this month" value={formatTokens(Number(usage?.tokens_month ?? 0))} />
        <MetricCard label="Usage cost this month" value={formatUsd(Number(usage?.cost_month ?? 0))} accent />
      </div>

      <Card className="mt-6">
        <CardHeader><CardTitle>Plans</CardTitle></CardHeader>
        <CardContent className="grid gap-3 pt-4 sm:grid-cols-2 lg:grid-cols-4">
          {PLANS.map((p) => (
            <div
              key={p.id}
              className={cn(
                "rounded-lg border p-4",
                p.id === plan ? "border-phosphor/40 bg-phosphor/5" : "border-line bg-raised/40",
              )}
            >
              <div className="flex items-center justify-between">
                <p className="text-sm font-semibold">{p.name}</p>
                {p.id === plan && <Badge tone="phosphor">current</Badge>}
              </div>
              <p className="mt-1 font-mono text-lg font-semibold">{p.price}<span className="text-xs font-normal text-faint">{p.id !== "enterprise" && "/mo"}</span></p>
              <p className="mt-2 text-xs leading-relaxed text-muted">{p.blurb}</p>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card className="mt-4">
        <CardHeader><CardTitle>Invoice history</CardTitle></CardHeader>
        <CardContent className="pt-3">
          {(records ?? []).length === 0 && (
            <p className="py-6 text-center text-sm text-faint">No invoices yet. Billing records are generated monthly.</p>
          )}
          <div className="divide-y divide-line/60">
            {(records ?? []).map((r: any) => (
              <div key={r.id} className="flex items-center justify-between gap-4 py-2.5">
                <div>
                  <p className="font-mono text-[13px]">{r.period_start} → {r.period_end}</p>
                  <p className="text-[11px] text-faint">
                    {r.plan} plan · base {formatUsd(Number(r.base_amount_usd))} + usage {formatUsd(Number(r.usage_amount_usd))}
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <span className="font-mono text-sm font-semibold">{formatUsd(Number(r.total_amount_usd))}</span>
                  <Badge tone={statusTone(r.status === "paid" ? "completed" : r.status)}>{r.status}</Badge>
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
