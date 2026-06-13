"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { AgentMessage } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Bot, FileCode2 } from "lucide-react";

export function ChatMessage({ message }: { message: AgentMessage }) {
  const isUser = message.role === "user";

  if (message.role === "system" || message.role === "tool") return null;

  const fileRefs = (message.parts ?? []).filter((p) => p.type === "file_ref") as Array<{ path: string }>;

  return (
    <div className={cn("flex gap-3 animate-slideUp", isUser && "flex-row-reverse")}>
      {!isUser && (
        <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-line bg-raised">
          <Bot className="h-3.5 w-3.5 text-phosphor" />
        </span>
      )}
      <div
        className={cn(
          "max-w-[78%] rounded-xl px-4 py-2.5 text-sm leading-relaxed",
          isUser
            ? "rounded-br-sm bg-raised border border-line"
            : "rounded-bl-sm bg-surface border border-line",
        )}
      >
        {isUser ? (
          <p className="whitespace-pre-wrap">{message.content}</p>
        ) : (
          <div className="prose-chat">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown>
          </div>
        )}
        {fileRefs.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5 border-t border-line/60 pt-2">
            {fileRefs.map((f, i) => (
              <span key={i} className="inline-flex items-center gap-1 rounded border border-line bg-raised px-1.5 py-0.5 font-mono text-[11px] text-muted">
                <FileCode2 className="h-3 w-3" /> {f.path}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
