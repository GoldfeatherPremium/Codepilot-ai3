import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { Bot, MessageSquare, Plus } from "lucide-react";

const PERMS: { key: string; label: string }[] = [
  { key: "can_read_repo", label: "read" },
  { key: "can_edit_repo", label: "edit" },
  { key: "can_create_commits", label: "commit" },
  { key: "can_create_prs", label: "PR" },
  { key: "can_execute_commands", label: "exec" },
];

export default async function AgentsPage() {
  const supabase = await createClient();
  const { data: agents } = await supabase
    .from("agents")
    .select("*, repositories(full_name)")
    .eq("is_archived", false)
    .order("created_at", { ascending: false });

  return (
    <div className="animate-slideUp">
      <PageHeader title="Agents" description="AI engineers configured with their own model, prompt, and permissions.">
        <Link href="/agents/new">
          <Button variant="phosphor" size="sm"><Plus className="h-4 w-4" /> New agent</Button>
        </Link>
      </PageHeader>

      {(agents ?? []).length === 0 && (
        <EmptyState
          icon={<Bot className="h-5 w-5" />}
          title="No agents yet"
          description="Create an agent, point it at a repository, and grant only the permissions it needs."
          actionLabel="Create agent"
          actionHref="/agents/new"
        />
      )}

      <div className="grid gap-3 md:grid-cols-2">
        {(agents ?? []).map((a: any) => (
          <div key={a.id} className="flex flex-col rounded-xl border border-line bg-surface p-4 transition-colors hover:border-faint/40">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold">{a.name}</p>
                <p className="mt-0.5 truncate font-mono text-[11px] text-faint">
                  {a.model} {a.repositories?.full_name ? `· ${a.repositories.full_name}` : "· no repository"}
                </p>
              </div>
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-line bg-raised">
                <Bot className="h-4 w-4 text-phosphor" />
              </span>
            </div>
            {a.description && <p className="mt-2 line-clamp-2 text-xs text-muted">{a.description}</p>}
            <div className="mt-3 flex flex-wrap gap-1.5">
              {PERMS.filter((p) => a[p.key]).map((p) => (
                <Badge key={p.key} tone="neutral">{p.label}</Badge>
              ))}
            </div>
            <div className="mt-4 flex-1" />
            <Link href={`/agents/${a.id}/chat`}>
              <Button variant="outline" size="sm" className="w-full">
                <MessageSquare className="h-3.5 w-3.5" /> Open chat
              </Button>
            </Link>
          </div>
        ))}
      </div>
    </div>
  );
}
