import { cn } from "@/lib/utils";

const tones = {
  neutral: "bg-raised text-muted border-line",
  phosphor: "bg-phosphor/12 text-phosphor border-phosphor/25",
  ok: "bg-ok/12 text-ok border-ok/25",
  danger: "bg-danger/12 text-danger border-danger/25",
  signal: "bg-signal/12 text-signal border-signal/25",
} as const;

export function Badge({
  tone = "neutral",
  className,
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & { tone?: keyof typeof tones }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium",
        tones[tone],
        className,
      )}
      {...props}
    />
  );
}

export function statusTone(status: string): keyof typeof tones {
  if (["completed", "succeeded", "success", "merged", "active", "synced"].includes(status)) return "ok";
  if (["failed", "error", "invalid", "rejected", "killed"].includes(status)) return "danger";
  if (["running", "syncing", "planning", "awaiting_approval", "queued", "timeout", "rate_limited"].includes(status)) return "phosphor";
  if (["open", "draft"].includes(status)) return "signal";
  return "neutral";
}
