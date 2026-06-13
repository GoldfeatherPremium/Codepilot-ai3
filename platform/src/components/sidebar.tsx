"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";
import {
  LayoutDashboard, FolderGit2, Bot, ListChecks, GitPullRequest,
  Brain, KeyRound, Settings, CreditCard, ShieldCheck, LogOut,
} from "lucide-react";

const NAV = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/repositories", label: "Repositories", icon: FolderGit2 },
  { href: "/agents", label: "Agents", icon: Bot },
  { href: "/tasks", label: "Tasks", icon: ListChecks },
  { href: "/pull-requests", label: "Pull Requests", icon: GitPullRequest },
  { href: "/memory", label: "Memory", icon: Brain },
  { href: "/providers", label: "AI Providers", icon: KeyRound },
  { href: "/settings", label: "Settings", icon: Settings },
  { href: "/billing", label: "Billing", icon: CreditCard },
];

export function Sidebar({
  user,
}: {
  user: { email: string; full_name: string | null; avatar_url: string | null; role: string };
}) {
  const pathname = usePathname();
  const router = useRouter();

  async function signOut() {
    await createClient().auth.signOut();
    router.push("/login");
    router.refresh();
  }

  return (
    <aside className="flex h-dvh w-[230px] shrink-0 flex-col border-r border-line bg-surface max-md:hidden">
      <div className="flex h-14 items-center gap-2.5 border-b border-line px-4">
        <span className="flex h-6 w-6 items-center justify-center rounded bg-phosphor font-mono text-xs font-bold text-black">▸</span>
        <span className="text-[13px] font-semibold tracking-tight">CodePilot AI</span>
      </div>

      <nav className="flex-1 space-y-0.5 overflow-y-auto p-2">
        {NAV.map((item) => {
          const active = pathname === item.href || pathname.startsWith(item.href + "/");
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "flex items-center gap-2.5 rounded-md px-2.5 py-[7px] text-[13px] transition-colors",
                active
                  ? "bg-raised text-ink font-medium"
                  : "text-muted hover:bg-raised/60 hover:text-ink",
              )}
            >
              <item.icon className={cn("h-4 w-4", active && "text-phosphor")} strokeWidth={1.75} />
              {item.label}
            </Link>
          );
        })}

        {user.role === "admin" && (
          <Link
            href="/admin"
            className={cn(
              "mt-2 flex items-center gap-2.5 rounded-md border border-dashed border-line px-2.5 py-[7px] text-[13px] transition-colors",
              pathname.startsWith("/admin") ? "bg-raised text-ink font-medium" : "text-muted hover:bg-raised/60 hover:text-ink",
            )}
          >
            <ShieldCheck className="h-4 w-4 text-signal" strokeWidth={1.75} />
            Admin
          </Link>
        )}
      </nav>

      <div className="border-t border-line p-3">
        <div className="flex items-center gap-2.5">
          {user.avatar_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={user.avatar_url} alt="" className="h-7 w-7 rounded-full border border-line" />
          ) : (
            <span className="flex h-7 w-7 items-center justify-center rounded-full border border-line bg-raised text-[11px] font-medium">
              {(user.full_name ?? user.email)[0]?.toUpperCase()}
            </span>
          )}
          <div className="min-w-0 flex-1">
            <p className="truncate text-xs font-medium">{user.full_name ?? user.email}</p>
            <p className="truncate text-[11px] text-faint">{user.email}</p>
          </div>
          <button
            onClick={signOut}
            title="Sign out"
            className="rounded-md p-1.5 text-faint transition-colors hover:bg-raised hover:text-ink"
          >
            <LogOut className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </aside>
  );
}
