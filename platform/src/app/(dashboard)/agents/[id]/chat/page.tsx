"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { api } from "@/lib/api";
import type { Agent, AgentMessage, AgentTask, TimelineEvent } from "@/lib/types";
import { ChatMessage } from "@/components/chat/message";
import { PlanCard } from "@/components/chat/plan-card";
import { ThinkingTimeline } from "@/components/chat/thinking-timeline";
import { Composer } from "@/components/chat/composer";
import { Badge } from "@/components/ui/badge";
import { ArrowLeft, Bot } from "lucide-react";

interface LiveRun { id: string; status: string; timeline: TimelineEvent[] }

export default function AgentChatPage() {
  const { id: agentId } = useParams<{ id: string }>();
  const supabase = createClient();

  const [agent, setAgent] = useState<Agent | null>(null);
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [tasks, setTasks] = useState<Record<string, AgentTask>>({});
  const [run, setRun] = useState<LiveRun | null>(null);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  // ---- initial load -------------------------------------------------------
  useEffect(() => {
    (async () => {
      const [{ data: a }, { data: msgs }, { data: ts }] = await Promise.all([
        supabase.from("agents").select("*, repositories(full_name)").eq("id", agentId).single(),
        supabase.from("agent_messages").select("*").eq("agent_id", agentId).order("created_at").limit(200),
        supabase.from("agent_tasks").select("*").eq("agent_id", agentId).order("created_at", { ascending: false }).limit(20),
      ]);
      setAgent(a as Agent);
      setMessages((msgs as AgentMessage[]) ?? []);
      const map: Record<string, AgentTask> = {};
      (ts ?? []).forEach((t: AgentTask) => { map[t.id] = t; });
      setTasks(map);

      const running = (ts ?? []).find((t: AgentTask) => t.status === "running");
      if (running) {
        const { data: r } = await supabase
          .from("agent_runs").select("id, status, timeline")
          .eq("task_id", running.id).order("created_at", { ascending: false }).limit(1).single();
        if (r) setRun(r as LiveRun);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId]);

  // ---- realtime subscriptions --------------------------------------------
  useEffect(() => {
    const channel = supabase
      .channel(`agent-${agentId}`)
      .on("postgres_changes",
        { event: "INSERT", schema: "public", table: "agent_messages", filter: `agent_id=eq.${agentId}` },
        (payload) => setMessages((m) => m.some((x) => x.id === (payload.new as any).id) ? m : [...m, payload.new as AgentMessage]),
      )
      .on("postgres_changes",
        { event: "*", schema: "public", table: "agent_tasks", filter: `agent_id=eq.${agentId}` },
        (payload) => {
          const t = payload.new as AgentTask;
          setTasks((prev) => ({ ...prev, [t.id]: t }));
        },
      )
      .on("postgres_changes",
        { event: "*", schema: "public", table: "agent_runs", filter: `agent_id=eq.${agentId}` },
        (payload) => {
          const r = payload.new as any;
          setRun({ id: r.id, status: r.status, timeline: (r.timeline ?? []) as TimelineEvent[] });
        },
      )
      .subscribe();
    return () => { supabase.removeChannel(channel); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, tasks, run?.timeline.length]);

  // ---- actions -------------------------------------------------------------
  const send = useCallback(async (text: string, mode: "chat" | "task") => {
    setError(null);
    // optimistic user message (server also persists one; dedup by id on insert)
    const optimistic: AgentMessage = {
      id: `local-${Date.now()}`, role: "user", content: text, parts: [],
      created_at: new Date().toISOString(), task_id: null, run_id: null,
    };
    setMessages((m) => [...m, optimistic]);
    try {
      if (mode === "task") {
        await api.agent.plan(agentId, text);
      } else {
        const { reply } = await api.agent.chat(agentId, text);
        // realtime insert will deliver the persisted assistant message; this is a fallback
        setMessages((m) => m.some((x) => x.role === "assistant" && x.content === reply)
          ? m
          : [...m, { id: `local-a-${Date.now()}`, role: "assistant", content: reply, parts: [], created_at: new Date().toISOString(), task_id: null, run_id: null }]);
      }
    } catch (e: any) {
      setError(e.message);
    }
  }, [agentId]);

  const approve = useCallback(async (taskId: string) => {
    setError(null);
    try { await api.agent.approve(taskId); } catch (e: any) { setError(e.message); }
  }, []);

  const reject = useCallback(async (taskId: string) => {
    setError(null);
    try { await api.agent.reject(taskId); } catch (e: any) { setError(e.message); }
  }, []);

  // ---- interleave messages and task cards by time --------------------------
  type Item = { at: string; kind: "msg"; msg: AgentMessage } | { at: string; kind: "task"; task: AgentTask };
  const items: Item[] = [
    ...messages.map((m) => ({ at: m.created_at, kind: "msg" as const, msg: m })),
    ...Object.values(tasks).filter((t) => t.plan).map((t) => ({ at: t.created_at, kind: "task" as const, task: t })),
  ].sort((a, b) => a.at.localeCompare(b.at));

  const liveRun = run && ["queued", "running"].includes(run.status);

  return (
    <div className="mx-auto flex h-[calc(100dvh-8rem)] max-w-3xl flex-col md:h-[calc(100dvh-4rem)]">
      <div className="mb-4 flex items-center gap-3">
        <Link href="/agents" className="flex h-9 w-9 items-center justify-center rounded-md text-faint hover:bg-raised hover:text-ink">
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <span className="flex h-8 w-8 items-center justify-center rounded-lg border border-line bg-raised">
          <Bot className="h-4 w-4 text-phosphor" />
        </span>
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">{agent?.name ?? "…"}</p>
          <p className="truncate font-mono text-[11px] text-faint">
            {agent?.model} {agent?.repositories?.full_name ? `· ${agent.repositories.full_name}` : ""}
          </p>
        </div>
        {liveRun && <Badge tone="phosphor" className="ml-auto"><span className="h-1.5 w-1.5 animate-pulseDot rounded-full bg-phosphor" /> running</Badge>}
      </div>

      <div className="flex-1 space-y-4 overflow-y-auto pb-4 pr-1">
        {items.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center text-center">
            <Bot className="h-8 w-8 text-faint" strokeWidth={1.5} />
            <p className="mt-3 text-sm font-medium">Start a conversation</p>
            <p className="mt-1 max-w-xs text-xs text-muted">
              Use <span className="text-phosphor">Task</span> mode for work that changes code — the agent plans first
              and waits for your approval. Use <span className="text-signal">Chat</span> to ask questions.
            </p>
          </div>
        )}

        {items.map((item) =>
          item.kind === "msg" ? (
            <ChatMessage key={item.msg.id} message={item.msg} />
          ) : (
            <PlanCard key={`task-${item.task.id}`} task={item.task} onApprove={approve} onReject={reject} />
          ),
        )}

        {run && run.timeline.length > 0 && (
          <ThinkingTimeline events={run.timeline} live={!!liveRun} />
        )}

        <div ref={bottomRef} />
      </div>

      {error && <p className="mb-2 text-xs text-danger">{error}</p>}
      <div className="pb-2">
        <Composer disabled={!agent || !!liveRun} onSend={send} />
      </div>
    </div>
  );
}
