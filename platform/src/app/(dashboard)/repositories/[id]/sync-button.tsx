"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { RefreshCw } from "lucide-react";

export function SyncButton({ repositoryId }: { repositoryId: string }) {
  const [busy, setBusy] = useState(false);
  const router = useRouter();

  async function sync() {
    setBusy(true);
    try {
      await api.github.sync(repositoryId);
      setTimeout(() => {
        router.refresh();
        setBusy(false);
      }, 4000);
    } catch {
      setBusy(false);
    }
  }

  return (
    <Button variant="outline" size="sm" onClick={sync} disabled={busy}>
      <RefreshCw className={`h-3.5 w-3.5 ${busy ? "animate-spin" : ""}`} />
      {busy ? "Syncing…" : "Sync"}
    </Button>
  );
}
