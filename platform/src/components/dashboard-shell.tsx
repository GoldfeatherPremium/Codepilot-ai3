"use client";

import { useState, useCallback } from "react";
import { Menu } from "lucide-react";
import { Sidebar } from "@/components/sidebar";
import { MobileDrawer } from "@/components/mobile-drawer";
import { BottomNav } from "@/components/bottom-nav";

interface User {
  email: string;
  full_name: string | null;
  avatar_url: string | null;
  role: string;
}

export function DashboardShell({ user, children }: { user: User; children: React.ReactNode }) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const closeDrawer = useCallback(() => setDrawerOpen(false), []);

  return (
    <div className="flex h-dvh overflow-hidden">
      {/* Desktop sidebar */}
      <Sidebar user={user} />

      {/* Mobile drawer */}
      <MobileDrawer open={drawerOpen} onClose={closeDrawer} user={user} />

      {/* Main content */}
      <main className="flex-1 overflow-y-auto pb-16 md:pb-0">
        {/* Mobile top bar */}
        <div className="flex h-14 items-center border-b border-line bg-surface px-4 md:hidden">
          <button
            onClick={() => setDrawerOpen(true)}
            className="mr-3 rounded-md p-2 text-muted transition-colors hover:bg-raised hover:text-ink"
            aria-label="Open menu"
          >
            <Menu className="h-5 w-5" />
          </button>
          <div className="flex items-center gap-2">
            <span className="flex h-5 w-5 items-center justify-center rounded bg-phosphor font-mono text-[10px] font-bold text-black">▸</span>
            <span className="text-[13px] font-semibold tracking-tight">CodePilot AI</span>
          </div>
        </div>

        <div className="mx-auto max-w-6xl px-4 py-6 md:px-10 md:py-8">
          {children}
        </div>
      </main>

      {/* Mobile bottom navigation */}
      <BottomNav onMore={() => setDrawerOpen(true)} />
    </div>
  );
}
