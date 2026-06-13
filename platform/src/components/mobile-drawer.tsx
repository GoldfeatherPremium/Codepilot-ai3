"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";
import {
  LayoutDashboard, FolderGit2, Bot, ListChecks, GitPullRequest,
  Brain, KeyRound, Settings, CreditCard, ShieldCheck, LogOut, X,
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

interface Props {
  open: boolean;
  onClose: () => void;
  user: { email: string; full_name: string | null; avatar_url: string | null; role: string };
}

export function MobileDrawer({ open, onClose, user }: Props) {
  const pathname = usePathname();
  const router = useRouter();
  const drawerRef = useRef<HTMLDivElement>(null);

  // Close on route change
  useEffect(() => { onClose(); }, [pathname, onClose]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    function handle(e: MouseEvent) {
      if (drawerRef.current && !drawerRef.current.contains(e.target as Node)) {
        onClose();
      }
    }
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [open, onClose]);

  // Prevent body scroll when open
  useEffect(() => {
    document.body.style.overflow = open ? "hidden" : "";
    return () => { document.body.style.overflow = ""; };
  }, [open]);

  async function signOut() {
    await createClient().auth.signOut();
    router.push("/login");
    router.refresh();
  }

  return (
    <>
      {/* Backdrop */}
      <div
        className={cn(
          "fixed inset-0 z-40 bg-black/60 backdrop-blur-sm transition-opacity duration-200 md:hidden",
          open ? "opacity-100" : "pointer-events-none opacity-0",
        )}
        aria-hidden
      />

      {/* Drawer */}
      <div
        ref={drawerRef}
        className={cn(
          "fixed inset-y-0 left-0 z-50 flex w-72 flex-col bg-surface shadow-2xl transition-transform duration-200 ease-out md:hidden",
          open ? "translate-x-0" : "-translate-x-full",
        )}
        aria-modal="true"
        role="dialog"
        aria-label="Navigation"
      >
        {/* Header */}
        <div className="flex h-14 items-center justify-between border-b border-line px-4">
          <div className="flex items-center gap-2.5">
            <span className="flex h-6 w-6 items-center justify-center rounded bg-phosphor font-mono text-xs font-bold text-black">▸</span>
            <span className="text-[13px] font-semibold tracking-tight">CodePilot AI</span>
          </div>
          <button
            onClick={onClose}
            className="rounded-md p-2 text-faint transition-colors hover:bg-raised hover:text-ink"
            aria-label="Close menu"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Nav */}
        <nav className="flex-1 space-y-0.5 overflow-y-auto p-2">
          {NAV.map((item) => {
            const active = pathname === item.href || pathname.startsWith(item.href + "/");
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  "flex min-h-[44px] items-center gap-3 rounded-md px-3 py-2 text-[13px] transition-colors",
                  active
                    ? "bg-raised text-ink font-medium"
                    : "text-muted hover:bg-raised/60 hover:text-ink",
                )}
              >
                <item.icon className={cn("h-4 w-4 shrink-0", active && "text-phosphor")} strokeWidth={1.75} />
                {item.label}
              </Link>
            );
          })}

          {user.role === "admin" && (
            <Link
              href="/admin"
              className={cn(
                "mt-2 flex min-h-[44px] items-center gap-3 rounded-md border border-dashed border-line px-3 py-2 text-[13px] transition-colors",
                pathname.startsWith("/admin") ? "bg-raised text-ink font-medium" : "text-muted hover:bg-raised/60 hover:text-ink",
              )}
            >
              <ShieldCheck className="h-4 w-4 shrink-0 text-signal" strokeWidth={1.75} />
              Admin
            </Link>
          )}
        </nav>

        {/* User */}
        <div className="border-t border-line p-3">
          <div className="flex items-center gap-2.5">
            {user.avatar_url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={user.avatar_url} alt="" className="h-8 w-8 rounded-full border border-line" />
            ) : (
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-line bg-raised text-[11px] font-medium">
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
              className="min-h-[44px] min-w-[44px] rounded-md p-2 text-faint transition-colors hover:bg-raised hover:text-ink"
            >
              <LogOut className="h-4 w-4" />
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
