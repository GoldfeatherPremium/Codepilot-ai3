import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { DashboardShell } from "@/components/dashboard-shell";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile } = await supabase
    .from("users")
    .select("email, full_name, avatar_url, role")
    .eq("id", user.id)
    .single();

  const userProps = {
    email: profile?.email ?? user.email ?? "",
    full_name: profile?.full_name ?? null,
    avatar_url: profile?.avatar_url ?? null,
    role: profile?.role ?? "user",
  };

  return <DashboardShell user={userProps}>{children}</DashboardShell>;
}
