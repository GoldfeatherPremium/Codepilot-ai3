"use client";

import { useRef, useState } from "react";
import { Textarea } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { ArrowUp, ListTree, Loader2, MessageSquare } from "lucide-react";

export function Composer({
  disabled,
  onSend,
}: {
  disabled: boolean;
  onSend: (text: string, mode: "chat" | "task") => Promise<void>;
}) {
  const [text, setText] = useState("");
  const [mode, setMode] = useState<"chat" | "task">("task");
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);

  async function submit() {
    const value = text.trim();
    if (!value || busy || disabled) return;
    setBusy(true);
    setText("");
    try {
      await onSend(value, mode);
    } finally {
      setBusy(false);
      ref.current?.focus();
    }
  }

  return (
    <div className="rounded-xl border border-line bg-surface p-2.5 focus-within:border-phosphor/40 transition-colors">
      <Textarea
        ref={ref}
        rows={2}
        className="border-0 bg-transparent px-1.5 py-1 focus:border-0"
        placeholder={mode === "task" ? "Describe a task — the agent will propose a plan first…" : "Ask the agent anything about the codebase…"}
        value={text}
        disabled={disabled || busy}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
      />
      <div className="flex items-center justify-between pt-1.5">
        <div className="flex gap-1 rounded-lg border border-line bg-raised p-0.5">
          <button
            onClick={() => setMode("task")}
            className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors ${mode === "task" ? "bg-surface text-phosphor" : "text-faint hover:text-muted"}`}
          >
            <ListTree className="h-3 w-3" /> Task
          </button>
          <button
            onClick={() => setMode("chat")}
            className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors ${mode === "chat" ? "bg-surface text-signal" : "text-faint hover:text-muted"}`}
          >
            <MessageSquare className="h-3 w-3" /> Chat
          </button>
        </div>
        <Button variant="phosphor" size="icon" onClick={submit} disabled={disabled || busy || !text.trim()} title="Send (Enter)">
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowUp className="h-4 w-4" />}
        </Button>
      </div>
    </div>
  );
}
