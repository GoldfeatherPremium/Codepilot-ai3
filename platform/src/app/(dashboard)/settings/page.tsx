"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Github, Loader2 } from "lucide-react";

interface Profile {
  id: string;
  email: string;
  full_name: string | null;
  github_username: string | null;
  github_connected_at: string | null;
  plan: string;
  role: string;
  notification_prefs: { email_pr: boolean; email_task_done: boolean; email_task_failed: boolean };
}

export default function SettingsPage() {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [githubError] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    return new URLSearchParams(window.location.search).get("github_error");
  });

  useEffect(() => {
    (async () => {
      const supabase = createClient();
      const { data: { user } } = await supabase.auth.getUser();
      const { data } = await supabase
        .from("users")
        .select("id, email, full_name, github_username, github_connected_at, plan, role, notification_prefs")
        .eq("id", user!.id)
        .single();
      setProfile(data as Profile);
      setName(data?.full_name ?? "");
    })();
  }, []);

  async function saveProfile() {
    if (!profile) return;
    setSaving(true);
    await createClient().from("users").update({ full_name: name.trim() || null }).eq("id", profile.id);
    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  async function setPref(key: keyof Profile["notification_prefs"], value: boolean) {
    if (!profile) return;
    const prefs = { ...profile.notification_prefs, [key]: value };
    setProfile({ ...profile, notification_prefs: prefs });
    await createClient().from("users").update({ notification_prefs: prefs }).eq("id", profile.id);
  }

  async function reconnectGitHub() {
    const supabase = createClient();
    await supabase.auth.signInWithOAuth({
      provider: "github",
      options: {
        redirectTo: `${window.location.origin}/auth/callback?next=/settings`,
        scopes: "read:user user:email repo",
      },
    });
  }

  if (!profile) return <p className="text-sm text-faint">Loading…</p>;

  return (
    <div className="mx-auto max-w-2xl animate-slideUp">
      <PageHeader title="Settings" />

      <Card>
        <CardHeader><CardTitle>Profile</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted">Email</label>
            <Input value={profile.email} disabled />
          </div>
          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted">Full name</label>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-2 text-xs text-faint">
              Plan: <Badge tone="signal">{profile.plan}</Badge>
              {profile.role === "admin" && <Badge tone="phosphor">admin</Badge>}
            </span>
            <Button size="sm" onClick={saveProfile} disabled={saving}>
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : saved ? "Saved ✓" : "Save"}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card className="mt-4">
        <CardHeader><CardTitle>GitHub connection</CardTitle></CardHeader>
        <CardContent>
          {profile.github_connected_at ? (
            <div className="flex items-center justify-between">
              <p className="flex items-center gap-2 text-sm">
                <Github className="h-4 w-4" />
                Connected as <span className="font-mono">{profile.github_username ?? "—"}</span>
                <Badge tone="ok">active</Badge>
              </p>
              <Button variant="outline" size="sm" onClick={reconnectGitHub}>Reconnect</Button>
            </div>
          ) : (
            <div className="flex items-center justify-between">
              <p className="text-sm text-muted">Not connected. Connect GitHub so agents can read and write repositories.</p>
              <Button variant="phosphor" size="sm" onClick={reconnectGitHub}>
                <Github className="h-4 w-4" /> Connect
              </Button>
            </div>
          )}
          {githubError && (
            <p className="mt-3 rounded bg-red-950/40 px-3 py-2 text-xs text-red-400">
              GitHub connection failed: {githubError}
            </p>
          )}
          <p className="mt-3 text-[11px] text-faint">
            The token is encrypted with AES-256-GCM and is never readable by the browser. Requested scopes: read:user, user:email, repo.
          </p>
        </CardContent>
      </Card>

      <Card className="mt-4">
        <CardHeader><CardTitle>Email notifications</CardTitle></CardHeader>
        <CardContent className="divide-y divide-line/60">
          <Switch checked={profile.notification_prefs.email_pr} onChange={(v) => setPref("email_pr", v)} label="Pull request opened" description="When an agent opens a PR on your behalf" />
          <Switch checked={profile.notification_prefs.email_task_done} onChange={(v) => setPref("email_task_done", v)} label="Task completed" description="When an approved task finishes successfully" />
          <Switch checked={profile.notification_prefs.email_task_failed} onChange={(v) => setPref("email_task_failed", v)} label="Task failed" description="When a run errors out or hits its iteration limit" />
        </CardContent>
      </Card>
    </div>
  );
}
