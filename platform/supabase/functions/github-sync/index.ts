// ============================================================================
// github-sync — list, import, and index repositories.
// actions: list_remote | import | sync
// "sync" pulls branches, recent commits, languages, open PRs, and indexes
// the file tree (with summaries + embeddings for source files).
// ============================================================================
import { handleOptions, json } from "../_shared/cors.ts";
import { adminClient, requireUser } from "../_shared/supabase.ts";
import { decryptSecret } from "../_shared/crypto.ts";
import { GitHubClient } from "../_shared/github.ts";
import { embed } from "../_shared/providers.ts";
import { extractIntel, resolveAgainstIndex } from "../_shared/intel.ts";

const INDEXABLE = /\.(ts|tsx|js|jsx|py|rb|go|rs|java|kt|swift|php|cs|c|cpp|h|hpp|sql|prisma|vue|svelte|md|yml|yaml|toml|json)$/i;
const SKIP_DIRS = /^(node_modules|\.git|dist|build|\.next|vendor|target|__pycache__)\//;

Deno.serve(async (req) => {
  const opt = handleOptions(req); if (opt) return opt;
  try {
    const { user } = await requireUser(req);
    const db = adminClient();
    const body = await req.json();

    const { data: allowed } = await db.rpc("check_rate_limit", {
      p_user_id: user.id, p_bucket: "github_sync", p_limit: 60, p_window_seconds: 3600,
    });
    if (!allowed) return json({ error: "Rate limit exceeded" }, 429);

    // store_token: called from the OAuth callback with the GitHub provider token.
    // Encrypted at rest; never returned to clients (column is revoked from anon/authenticated).
    if (body.action === "store_token") {
      if (typeof body.providerToken !== "string" || body.providerToken.length < 20) {
        return json({ error: "Invalid token" }, 400);
      }
      const { encryptSecret } = await import("../_shared/crypto.ts");
      const enc = await encryptSecret(body.providerToken);
      const { error } = await db.from("users").update({
        github_token_ciphertext: enc.ciphertext,
        github_token_iv: enc.iv,
        github_username: body.githubUsername ?? null,
        github_connected_at: new Date().toISOString(),
      }).eq("id", user.id);
      if (error) throw error;
      await db.rpc("write_audit", { p_user_id: user.id, p_action: "github_connected", p_resource_type: "user", p_resource_id: user.id, p_metadata: {} });
      return json({ ok: true });
    }

    const { data: u } = await db.from("users")
      .select("github_token_ciphertext, github_token_iv").eq("id", user.id).single();
    if (!u?.github_token_ciphertext) {
      return json({ error: "GitHub not connected. Connect it in Settings." }, 400);
    }
    const gh = new GitHubClient(await decryptSecret(u.github_token_ciphertext, u.github_token_iv));

    if (body.action === "list_remote") {
      const repos = await gh.listRepos(body.page ?? 1);
      return json(repos.map((r) => ({
        github_repo_id: r.id, full_name: r.full_name, name: r.name,
        description: r.description, private: r.private, default_branch: r.default_branch,
        stars: r.stargazers_count, html_url: r.html_url, updated_at: r.updated_at,
      })));
    }

    if (body.action === "import") {
      const r = await gh.getRepo(body.fullName);
      const { data: repo, error } = await db.from("repositories").upsert({
        user_id: user.id, github_repo_id: r.id, full_name: r.full_name, name: r.name,
        description: r.description, private: r.private, default_branch: r.default_branch,
        stars: r.stargazers_count, size_kb: r.size, clone_url: r.clone_url,
        html_url: r.html_url, topics: r.topics ?? [],
      }, { onConflict: "user_id,github_repo_id" }).select().single();
      if (error) throw error;
      await db.rpc("write_audit", { p_user_id: user.id, p_action: "repo_connected", p_resource_type: "repository", p_resource_id: repo.id, p_metadata: { full_name: r.full_name } });
      return json({ repositoryId: repo.id });
    }

    if (body.action === "sync") {
      const { data: repo } = await db.from("repositories")
        .select("*").eq("id", body.repositoryId).eq("user_id", user.id).single();
      if (!repo) return json({ error: "Repository not found" }, 404);

      await db.from("repositories").update({ sync_status: "syncing" }).eq("id", repo.id);
      EdgeRuntime.waitUntil(syncRepo(db, user.id, gh, repo).catch(async (e) => {
        await db.from("repositories").update({ sync_status: "error", sync_error: String(e) }).eq("id", repo.id);
      }));
      return json({ status: "syncing" });
    }

    return json({ error: "Unknown action" }, 400);
  } catch (e) {
    return json({ error: (e as Error).message }, (e as any).status ?? 500);
  }
});

async function syncRepo(db: any, userId: string, gh: GitHubClient, repo: any) {
  // Languages + branches
  const [languages, branches] = await Promise.all([
    gh.getLanguages(repo.full_name),
    gh.listBranches(repo.full_name),
  ]);
  await db.from("repository_branches").upsert(
    branches.map((b: any) => ({
      repository_id: repo.id, name: b.name, head_sha: b.commit.sha,
      is_default: b.name === repo.default_branch, protected: b.protected,
      updated_at: new Date().toISOString(),
    })), { onConflict: "repository_id,name" });

  // Recent commits on default branch
  const commits = await gh.listCommits(repo.full_name, repo.default_branch, 30);
  for (const c of commits) {
    await db.from("commits").upsert({
      repository_id: repo.id, sha: c.sha, branch: repo.default_branch,
      message: c.commit.message, authored_by_agent: false, github_url: c.html_url,
      created_at: c.commit.author?.date,
    }, { onConflict: "repository_id,sha", ignoreDuplicates: true });
  }

  // Open PRs on GitHub side
  const prs = await gh.listPullRequests(repo.full_name, "open");
  for (const p of prs) {
    await db.from("pull_requests").upsert({
      repository_id: repo.id, user_id: userId, github_pr_number: p.number,
      title: p.title, body: p.body ?? "", head_branch: p.head.ref, base_branch: p.base.ref,
      status: "open", github_url: p.html_url,
    }, { onConflict: "repository_id,github_pr_number", ignoreDuplicates: true }).select();
  }

  // File tree index (paths + metadata; embeddings for a bounded set of files)
  const headSha = branches.find((b: any) => b.name === repo.default_branch)?.commit.sha;
  let fileCount = 0;
  if (headSha) {
    const tree = await gh.getTree(repo.full_name, headSha);
    const files = tree.tree.filter((f) => f.type === "blob" && !SKIP_DIRS.test(f.path));
    fileCount = files.length;
    // Upsert metadata in batches
    for (let i = 0; i < files.length; i += 500) {
      await db.from("repository_files").upsert(
        files.slice(i, i + 500).map((f) => ({
          repository_id: repo.id, branch: repo.default_branch, path: f.path,
          sha: f.sha, size_bytes: f.size ?? 0,
          language: extToLang(f.path), is_binary: !INDEXABLE.test(f.path),
          indexed_at: new Date().toISOString(),
        })), { onConflict: "repository_id,branch,path" });
    }
    // ---- content pass: embeddings + code intelligence ----------------------
    // One download per file feeds both the semantic index (embeddings, when an
    // OpenAI key exists) and the symbol/dependency extraction (always).
    const { data: openaiCfg } = await db.from("provider_configs")
      .select("key_ciphertext, key_iv").eq("user_id", userId).eq("provider", "openai").limit(1).maybeSingle();
    const embedKey = openaiCfg ? await decryptSecret(openaiCfg.key_ciphertext, openaiCfg.key_iv) : null;

    const CODE = /\.(ts|tsx|js|jsx|mjs|cjs|py|php|go|rs)$/i;
    const intelCandidates = files
      .filter((f) => CODE.test(f.path) && (f.size ?? 0) < 120_000)
      .sort((a, b) => importance(b.path) - importance(a.path))
      .slice(0, 400);
    const embedSet = new Set(
      intelCandidates.filter((f) => INDEXABLE.test(f.path) && (f.size ?? 0) < 60_000)
        .slice(0, 150).map((f) => f.path),
    );
    const indexedPaths = new Set(files.map((f) => f.path));

    // Rebuild intelligence for this repo from scratch (sync is authoritative).
    await db.from("code_symbols").delete().eq("repository_id", repo.id);
    await db.from("file_dependencies").delete().eq("repository_id", repo.id);

    const symbolRows: any[] = [];
    const depRows: any[] = [];

    for (const f of intelCandidates) {
      let content: string;
      try {
        content = await gh.getFileContent(repo.full_name, f.path, repo.default_branch);
      } catch { continue; }

      // 1) symbols + imports
      try {
        const intel = extractIntel(f.path, content);
        for (const s of intel.symbols.slice(0, 200)) {
          symbolRows.push({
            repository_id: repo.id, file_path: f.path, name: s.name, kind: s.kind,
            line: s.line, signature: s.signature, exported: s.exported,
          });
        }
        for (const imp of intel.imports.slice(0, 100)) {
          const resolved = imp.external ? null
            : imp.resolved ? resolveAgainstIndex(imp.resolved, indexedPaths) ?? imp.resolved : null;
          depRows.push({
            repository_id: repo.id, from_path: f.path, to_path: resolved,
            import_spec: imp.spec, imported_names: imp.names.slice(0, 30),
            is_external: imp.external,
          });
        }
        await db.from("repository_files").update({
          symbols: {
            defs: intel.symbols.slice(0, 80).map((s) => ({ n: s.name, k: s.kind, l: s.line })),
            imports: intel.imports.slice(0, 40).map((i) => i.spec),
          },
        }).eq("repository_id", repo.id).eq("branch", repo.default_branch).eq("path", f.path);
      } catch { /* intel extraction is best-effort per file */ }

      // 2) embedding (bounded set, requires key)
      if (embedKey && embedSet.has(f.path)) {
        try {
          const summary = content.slice(0, 1200);
          const vec = await embed(embedKey, `${f.path}\n${summary}`);
          await db.from("repository_files").update({ summary, embedding: vec })
            .eq("repository_id", repo.id).eq("branch", repo.default_branch).eq("path", f.path);
        } catch { /* skip embedding failure */ }
      }
    }

    for (let i = 0; i < symbolRows.length; i += 500) {
      await db.from("code_symbols").insert(symbolRows.slice(i, i + 500));
    }
    for (let i = 0; i < depRows.length; i += 500) {
      await db.from("file_dependencies").insert(depRows.slice(i, i + 500));
    }
  }

  await db.from("repositories").update({
    languages, sync_status: "synced", sync_error: null,
    last_synced_at: new Date().toISOString(), indexed_file_count: fileCount,
  }).eq("id", repo.id);
}

function importance(path: string): number {
  let s = 0;
  if (/(^|\/)(index|main|app|server|schema|routes?|api)\./i.test(path)) s += 3;
  if (/^src\//.test(path)) s += 2;
  if (/readme\.md$/i.test(path)) s += 4;
  if (/(package|pyproject|go\.mod|cargo)\./i.test(path)) s += 3;
  s -= path.split("/").length * 0.2;
  return s;
}
function extToLang(p: string): string | null {
  const m: Record<string, string> = { ts: "TypeScript", tsx: "TypeScript", js: "JavaScript", jsx: "JavaScript", py: "Python", rb: "Ruby", go: "Go", rs: "Rust", java: "Java", kt: "Kotlin", swift: "Swift", php: "PHP", cs: "C#", sql: "SQL", md: "Markdown", vue: "Vue", svelte: "Svelte" };
  return m[p.split(".").pop()?.toLowerCase() ?? ""] ?? null;
}
