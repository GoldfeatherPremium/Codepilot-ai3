// ============================================================================
// GitHub REST client (edge runtime). Token is the user's encrypted OAuth
// token, decrypted just-in-time inside the function.
// ============================================================================

const GH = "https://api.github.com";

export class GitHubClient {
  constructor(private token: string) {}

  /** Exposes the token for trusted server-to-server use (e.g. sandbox runner clone). */
  get authToken(): string { return this.token; }

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${GH}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text();
      throw Object.assign(new Error(`GitHub ${res.status} ${path}: ${text}`), { status: res.status });
    }
    return res.status === 204 ? (undefined as T) : await res.json();
  }

  listRepos(page = 1) {
    return this.req<any[]>("GET", `/user/repos?per_page=100&page=${page}&sort=updated`);
  }
  getRepo(fullName: string) {
    return this.req<any>("GET", `/repos/${fullName}`);
  }
  getLanguages(fullName: string) {
    return this.req<Record<string, number>>("GET", `/repos/${fullName}/languages`);
  }
  listBranches(fullName: string) {
    return this.req<any[]>("GET", `/repos/${fullName}/branches?per_page=100`);
  }
  listCommits(fullName: string, branch: string, perPage = 30) {
    return this.req<any[]>("GET", `/repos/${fullName}/commits?sha=${branch}&per_page=${perPage}`);
  }
  /** Full recursive tree for indexing. */
  getTree(fullName: string, sha: string) {
    return this.req<{ tree: { path: string; type: string; sha: string; size?: number }[] }>(
      "GET", `/repos/${fullName}/git/trees/${sha}?recursive=1`);
  }
  async getFileContent(fullName: string, path: string, ref: string): Promise<string> {
    const data = await this.req<{ content: string; encoding: string }>(
      "GET", `/repos/${fullName}/contents/${encodeURIComponent(path)}?ref=${ref}`);
    return data.encoding === "base64"
      ? new TextDecoder().decode(Uint8Array.from(atob(data.content.replace(/\n/g, "")), (c) => c.charCodeAt(0)))
      : data.content;
  }
  createBranch(fullName: string, name: string, fromSha: string) {
    return this.req("POST", `/repos/${fullName}/git/refs`, { ref: `refs/heads/${name}`, sha: fromSha });
  }
  getBranchSha(fullName: string, branch: string) {
    return this.req<{ object: { sha: string } }>("GET", `/repos/${fullName}/git/ref/heads/${branch}`)
      .then((r) => r.object.sha);
  }
  /** Create or update a single file on a branch (Contents API). */
  async putFile(fullName: string, path: string, branch: string, content: string, message: string) {
    let sha: string | undefined;
    try {
      const existing = await this.req<{ sha: string }>(
        "GET", `/repos/${fullName}/contents/${encodeURIComponent(path)}?ref=${branch}`);
      sha = existing.sha;
    } catch { /* new file */ }
    return this.req<any>("PUT", `/repos/${fullName}/contents/${encodeURIComponent(path)}`, {
      message, branch, sha,
      content: btoa(unescape(encodeURIComponent(content))),
    });
  }
  deleteFile(fullName: string, path: string, branch: string, sha: string, message: string) {
    return this.req("DELETE", `/repos/${fullName}/contents/${encodeURIComponent(path)}`, { message, branch, sha });
  }
  /** Atomic multi-file commit via the Git Data API. */
  async commitFiles(
    fullName: string, branch: string, message: string,
    files: { path: string; content: string | null }[], // content null = delete
  ) {
    const headSha = await this.getBranchSha(fullName, branch);
    const headCommit = await this.req<{ tree: { sha: string } }>("GET", `/repos/${fullName}/git/commits/${headSha}`);
    const tree = await this.req<{ sha: string }>("POST", `/repos/${fullName}/git/trees`, {
      base_tree: headCommit.tree.sha,
      tree: files.map((f) => ({
        path: f.path, mode: "100644", type: "blob",
        ...(f.content === null ? { sha: null } : { content: f.content }),
      })),
    });
    const commit = await this.req<{ sha: string; html_url: string }>("POST", `/repos/${fullName}/git/commits`, {
      message, tree: tree.sha, parents: [headSha],
    });
    await this.req("PATCH", `/repos/${fullName}/git/refs/heads/${branch}`, { sha: commit.sha });
    return commit;
  }
  createPullRequest(fullName: string, p: { title: string; body: string; head: string; base: string }) {
    return this.req<{ number: number; html_url: string; additions: number; deletions: number; changed_files: number }>(
      "POST", `/repos/${fullName}/pulls`, p);
  }
  listPullRequests(fullName: string, state = "open") {
    return this.req<any[]>("GET", `/repos/${fullName}/pulls?state=${state}&per_page=50`);
  }
}
