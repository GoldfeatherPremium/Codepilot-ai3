import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { Sidebar } from "@/components/sidebar";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile } = await supabase
    .from("users")
    .select("email, full_name, avatar_url, role")
    .eq("id", user.id)
    .single();

  return (
    <div className="flex h-dvh overflow-hidden">
      <Sidebar
        user={{
          email: profile?.email ?? user.email ?? "",
          full_name: profile?.full_name ?? null,
          avatar_url: profile?.avatar_url ?? null,
          role: profile?.role ?? "user",
        }}
      />
      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-6xl px-6 py-8 md:px-10">{children}</div>
      </main>
    </div>
  );
}
