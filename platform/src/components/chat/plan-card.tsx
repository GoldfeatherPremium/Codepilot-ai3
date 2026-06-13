"use client";

import { useState } from "react";
import type { AgentTask } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Badge, statusTone } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { Check, CircleDashed, ListTree, Loader2, X, XCircle } from "lucide-react";

function StepDot({ status }: { status: string }) {
  if (status === "done") return <Check className="h-3.5 w-3.5 text-ok" />;
  if (status === "failed") return <XCircle className="h-3.5 w-3.5 text-danger" />;
  if (status === "running") return <Loader2 className="h-3.5 w-3.5 animate-spin text-phosphor" />;
  return <CircleDashed className="h-3.5 w-3.5 text-faint" />;
}

export function PlanCard({
  task,
  onApprove,
  onReject,
}: {
  task: AgentTask;
  onApprove: (taskId: string) => Promise<void>;
  onReject: (taskId: string) => Promise<void>;
}) {
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const awaiting = task.status === "awaiting_approval";
  const steps = task.plan?.steps ?? [];

  async function act(kind: "approve" | "reject") {
    setBusy(kind);
    try {
      await (kind === "approve" ? onApprove(task.id) : onReject(task.id));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className={cn(
      "animate-slideUp rounded-xl border bg-surface p-4",
      awaiting ? "border-phosphor/40 shadow-[0_0_24px_-12px_hsl(38_96%_56%/0.5)]" : "border-line",
    )}>
      <div className="flex items-start justify-between gap-3">
        <p className="flex items-center gap-2 text-sm font-semibold">
          <ListTree className="h-4 w-4 text-phosphor" />
          {task.plan?.title ?? task.title}
        </p>
        <Badge tone={statusTone(task.status)}>{task.status.replace(/_/g, " ")}</Badge>
      </div>

      <ol className="mt-3 space-y-2">
        {steps.map((s) => (
          <li key={s.step} className="flex items-start gap-2.5">
            <span className="mt-0.5"><StepDot status={s.status} /></span>
            <span className="min-w-0">
              <span className={cn("block text-[13px]", s.status === "done" ? "text-muted line-through decoration-line" : "text-ink")}>
                {s.step}. {s.title}
              </span>
              {s.detail && <span className="block text-xs text-faint">{s.detail}</span>}
            </span>
          </li>
        ))}
      </ol>

      {task.branch_name && (
        <p className="mt-3 font-mono text-[11px] text-faint">branch: {task.branch_name}</p>
      )}
      {task.error && <p className="mt-3 text-xs text-danger">{task.error}</p>}
      {task.result_summary && task.status === "completed" && (
        <p className="mt-3 rounded-md border border-ok/20 bg-ok/8 p-2.5 text-xs text-muted">{task.result_summary}</p>
      )}

      {awaiting && (
        <div className="mt-4 flex items-center gap-2 border-t border-line pt-3.5">
          <Button variant="phosphor" size="sm" onClick={() => act("approve")} disabled={busy !== null}>
            {busy === "approve" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
            Approve & run
          </Button>
          <Button variant="ghost" size="sm" onClick={() => act("reject")} disabled={busy !== null}>
            <X className="h-3.5 w-3.5" /> Reject
          </Button>
          <span className="ml-auto text-[11px] text-faint">Nothing executes until you approve.</span>
        </div>
      )}
    </div>
  );
}
