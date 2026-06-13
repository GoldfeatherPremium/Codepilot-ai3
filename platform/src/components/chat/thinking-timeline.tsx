"use client";

import type { TimelineEvent } from "@/lib/types";
import { cn } from "@/lib/utils";
import {
  BrainCircuit, Camera, FileEdit, ListTree, ScrollText, TerminalSquare, Wrench, CheckCircle2,
} from "lucide-react";

const ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  thinking: BrainCircuit,
  tool_call: Wrench,
  tool_result: CheckCircle2,
  plan: ListTree,
  file_edit: FileEdit,
  log: ScrollText,
  snapshot: Camera,
  repair: Wrench,
};

function eventLabel(e: TimelineEvent): string {
  if (e.type === "tool_call" && e.tool === "execute_command") return `$ ${String(e.args?.command ?? "")}`;
  if (e.type === "tool_call") return `${e.tool}(${summarizeArgs(e.args)})`;
  if (e.type === "log") return `${e.tool ?? "output"} — live output`;
  if (e.type === "repair") return e.text ?? "repair loop";
  return e.text ?? e.preview ?? e.type;
}

function summarizeArgs(args?: Record<string, unknown>): string {
  if (!args) return "";
  const v = args.path ?? args.query ?? args.title ?? args.message ?? "";
  return typeof v === "string" ? v.slice(0, 60) : "";
}

// Vertical rail of agent activity. The newest node pulses phosphor while a run
// is live — the "instrument panel" signature of the product.
export function ThinkingTimeline({ events: rawEvents, live }: { events: TimelineEvent[]; live: boolean }) {
  const events: TimelineEvent[] = [];
  for (const e of rawEvents) {
    const prev = events[events.length - 1];
    if (e.type === "log" && prev?.type === "log" && prev.tool === e.tool) {
      prev.text = ((prev.text ?? "") + (e.text ?? "")).slice(-12_000);
      prev.at = e.at;
    } else {
      events.push({ ...e });
    }
  }
  if (!events.length) return null;

  return (
    <div className="rounded-xl border border-line bg-surface/70 p-4">
      <p className="mb-3 flex items-center gap-2 font-mono text-[11px] uppercase tracking-wider text-faint">
        <TerminalSquare className="h-3.5 w-3.5" />
        agent activity
        {live && <span className="h-1.5 w-1.5 animate-pulseDot rounded-full bg-phosphor" />}
      </p>
      <ol className="relative ml-1.5 space-y-0 border-l border-line">
        {events.map((e, i) => {
          const Icon = ICONS[e.type] ?? Wrench;
          const isLast = i === events.length - 1;
          const isExec = e.type === "tool_call" && e.tool === "execute_command";
          const isRepair = e.type === "repair";
          return (
            <li key={i} className="relative pb-3 pl-5 last:pb-0">
              <span
                className={cn(
                  "absolute -left-[5px] top-1 h-2.5 w-2.5 rounded-full border",
                  isLast && live
                    ? "animate-pulseDot border-phosphor bg-phosphor"
                    : "border-line bg-raised",
                )}
              />
              <div className="flex items-start gap-2">
                <Icon className={cn("mt-0.5 h-3.5 w-3.5 shrink-0", isLast && live ? "text-phosphor" : "text-faint")} />
                <div className="min-w-0">
                  <p className={cn(
                    "break-words text-[12.5px] leading-snug",
                    isExec ? "font-mono text-phosphor/90" : isRepair ? "font-medium text-warn" : "text-muted",
                    isLast && live && "text-ink",
                  )}>
                    {eventLabel(e)}
                  </p>
                  {e.type === "log" && e.text && (
                    <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded-md border border-line bg-bg p-2 font-mono text-[11px] leading-relaxed text-muted">
                      {e.text}
                    </pre>
                  )}
                  {e.preview && e.type === "tool_result" && (
                    <pre className="mt-1 max-h-28 overflow-auto rounded-md border border-line bg-bg p-2 font-mono text-[11px] leading-relaxed text-faint">
                      {e.preview}
                    </pre>
                  )}
                </div>
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
