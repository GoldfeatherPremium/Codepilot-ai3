import Link from "next/link";
import { Button } from "@/components/ui/button";
import {
  GitPullRequest,
  Brain,
  TerminalSquare,
  GitBranch,
  ShieldCheck,
  Cpu,
} from "lucide-react";

const features = [
  {
    icon: GitBranch,
    title: "Whole-codebase understanding",
    body: "Repositories are indexed with hybrid semantic + path search so agents read the right files, not random ones.",
  },
  {
    icon: Brain,
    title: "Permanent project memory",
    body: "User, repository, and task-scoped memories with pgvector recall. Your agent remembers decisions from months ago.",
  },
  {
    icon: GitPullRequest,
    title: "Plans, commits & pull requests",
    body: "Agents propose a step-by-step plan, wait for your approval, then branch, commit, and open a reviewed PR.",
  },
  {
    icon: TerminalSquare,
    title: "Sandboxed execution",
    body: "Terminal commands run in isolated sandboxes with full logs, exit codes, and status tracking.",
  },
  {
    icon: Cpu,
    title: "14 AI providers",
    body: "OpenAI, Anthropic, Gemini, Bedrock, Vertex, Groq, DeepSeek and more — bring your own encrypted keys.",
  },
  {
    icon: ShieldCheck,
    title: "Enterprise security",
    body: "Row-level security, AES-256-GCM key storage, audit logs, granular agent permissions, rate limiting.",
  },
];

export default function LandingPage() {
  return (
    <div className="mx-auto flex min-h-dvh max-w-6xl flex-col px-4 sm:px-6">
      <header className="flex h-16 items-center justify-between">
        <div className="flex items-center gap-2.5">
          <span className="flex h-7 w-7 items-center justify-center rounded-md bg-phosphor font-mono text-sm font-bold text-black">
            ▸
          </span>
          <span className="text-sm font-semibold tracking-tight">CodePilot AI</span>
        </div>
        <nav className="flex items-center gap-1.5 sm:gap-2">
          <Link href="/login">
            <Button variant="ghost" size="sm">Sign in</Button>
          </Link>
          <Link href="/login">
            <Button variant="phosphor" size="sm">Get started</Button>
          </Link>
        </nav>
      </header>

      <main className="flex-1">
        <section className="py-16 text-center md:py-32">
          <p className="mb-5 inline-flex items-center gap-2 rounded-full border border-line bg-surface px-3 py-1 font-mono text-[11px] text-muted">
            <span className="h-1.5 w-1.5 animate-pulseDot rounded-full bg-phosphor" />
            agents online
          </p>
          <h1 className="mx-auto max-w-3xl text-balance text-3xl font-semibold tracking-tight sm:text-4xl md:text-6xl">
            An AI engineer that ships
            <span className="text-phosphor"> pull requests</span>, not snippets.
          </h1>
          <p className="mx-auto mt-5 max-w-xl text-balance text-sm text-muted sm:text-base md:text-lg">
            Connect a repository, describe the task, approve the plan. CodePilot reads your codebase,
            edits files, runs commands, and opens the PR — with memory that persists forever.
          </p>
          <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Link href="/login" className="w-full sm:w-auto">
              <Button variant="phosphor" size="lg" className="w-full sm:w-auto">Connect GitHub</Button>
            </Link>
            <Link href="#features" className="w-full sm:w-auto">
              <Button variant="outline" size="lg" className="w-full sm:w-auto">See how it works</Button>
            </Link>
          </div>

          <div className="mx-auto mt-12 max-w-2xl overflow-hidden rounded-xl border border-line bg-surface text-left shadow-2xl shadow-black/40 md:mt-16">
            <div className="flex items-center gap-1.5 border-b border-line px-4 py-2.5">
              <span className="h-2.5 w-2.5 rounded-full bg-line" />
              <span className="h-2.5 w-2.5 rounded-full bg-line" />
              <span className="h-2.5 w-2.5 rounded-full bg-line" />
              <span className="ml-2 font-mono text-[11px] text-faint">codepilot · task #4f2a</span>
            </div>
            <div className="space-y-2.5 p-5 font-mono text-[12.5px] leading-relaxed">
              <p className="text-muted">› add affiliate system with referral tracking</p>
              <p className="text-phosphor">✓ plan approved · 6 steps</p>
              <p className="text-faint">  reading src/lib/auth.ts · supabase/migrations …</p>
              <p className="text-faint">  wrote 00012_affiliates.sql · src/app/affiliates/page.tsx (+412)</p>
              <p className="text-faint">  $ npm test — 84 passed</p>
              <p className="text-ok">✓ PR #218 opened: feat: affiliate & referral system</p>
            </div>
          </div>
        </section>

        <section id="features" className="grid gap-3 pb-20 sm:grid-cols-2 sm:gap-4 lg:grid-cols-3">
          {features.map((f) => (
            <div key={f.title} className="rounded-xl border border-line bg-surface p-5">
              <f.icon className="h-5 w-5 text-phosphor" strokeWidth={1.75} />
              <h3 className="mt-4 text-sm font-semibold">{f.title}</h3>
              <p className="mt-1.5 text-sm leading-relaxed text-muted">{f.body}</p>
            </div>
          ))}
        </section>
      </main>

      <footer className="flex h-16 items-center justify-between border-t border-line text-xs text-faint">
        <span>© {new Date().getFullYear()} CodePilot AI</span>
        <span className="font-mono">built for engineers</span>
      </footer>
    </div>
  );
}
