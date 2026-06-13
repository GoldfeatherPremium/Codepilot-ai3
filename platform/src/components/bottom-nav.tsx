"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { LayoutDashboard, FolderGit2, Bot, ListChecks, MoreHorizontal } from "lucide-react";

const BOTTOM_NAV = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/repositories", label: "Repos", icon: FolderGit2 },
  { href: "/agents", label: "Agents", icon: Bot },
  { href: "/tasks", label: "Tasks", icon: ListChecks },
];

interface Props {
  onMore: () => void;
}

export function BottomNav({ onMore }: Props) {
  const pathname = usePathname();

  return (
    <nav
      className="fixed bottom-0 left-0 right-0 z-30 flex h-16 items-stretch border-t border-line bg-surface md:hidden"
      aria-label="Bottom navigation"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      {BOTTOM_NAV.map((item) => {
        const active = pathname === item.href || pathname.startsWith(item.href + "/");
        return (
          <Link
            key={item.href}
            href={item.href}
            className={cn(
              "flex flex-1 flex-col items-center justify-center gap-1 text-[10px] transition-colors",
              active ? "text-phosphor" : "text-faint hover:text-muted",
            )}
            aria-current={active ? "page" : undefined}
          >
            <item.icon className="h-5 w-5" strokeWidth={active ? 2 : 1.75} />
            <span>{item.label}</span>
          </Link>
        );
      })}

      {/* More button opens drawer */}
      <button
        onClick={onMore}
        className="flex flex-1 flex-col items-center justify-center gap-1 text-[10px] text-faint transition-colors hover:text-muted"
        aria-label="More navigation options"
      >
        <MoreHorizontal className="h-5 w-5" strokeWidth={1.75} />
        <span>More</span>
      </button>
    </nav>
  );
}
