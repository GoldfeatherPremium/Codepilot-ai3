// ============================================================================
// intel.ts — lightweight code intelligence extraction.
//
// Regex-based symbol and import extraction for the languages the sandbox
// supports (TypeScript/JavaScript, Python, PHP, Go, Rust). Deliberately not a
// full parser: it runs inside an edge function over hundreds of files per
// sync, so it must be fast and allocation-light. It captures the definitions
// and import edges that matter for navigation — function map, class map,
// exports, and the dependency graph — with line numbers and signatures.
// ============================================================================

export interface ExtractedSymbol {
  name: string;
  kind: "function" | "method" | "class" | "interface" | "type" | "enum"
      | "const" | "var" | "struct" | "trait" | "impl" | "module" | "component" | "export";
  line: number;
  signature: string;
  exported: boolean;
}

export interface ExtractedImport {
  spec: string;            // as written: './auth', 'react', 'os.path'
  names: string[];         // imported identifiers (best effort)
  resolved: string | null; // repo-relative path for relative imports
  external: boolean;
}

export interface FileIntel {
  symbols: ExtractedSymbol[];
  imports: ExtractedImport[];
}

const sig = (line: string) => line.trim().slice(0, 200);

export function extractIntel(path: string, content: string): FileIntel {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  const lines = content.split("\n");
  switch (ext) {
    case "ts": case "tsx": case "js": case "jsx": case "mjs": case "cjs":
      return { symbols: tsSymbols(lines), imports: tsImports(lines, path) };
    case "py":
      return { symbols: pySymbols(lines), imports: pyImports(lines, path) };
    case "php":
      return { symbols: phpSymbols(lines), imports: phpImports(lines) };
    case "go":
      return { symbols: goSymbols(lines), imports: goImports(lines) };
    case "rs":
      return { symbols: rsSymbols(lines), imports: rsImports(lines) };
    default:
      return { symbols: [], imports: [] };
  }
}

// --- TypeScript / JavaScript ---------------------------------------------------

function tsSymbols(lines: string[]): ExtractedSymbol[] {
  const out: ExtractedSymbol[] = [];
  const push = (name: string, kind: ExtractedSymbol["kind"], i: number, exported: boolean) =>
    out.push({ name, kind, line: i + 1, signature: sig(lines[i]), exported });

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    let m: RegExpMatchArray | null;
    const exported = /^\s*export\s/.test(l);

    if ((m = l.match(/^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s+([A-Za-z_$][\w$]*)/)))
      push(m[1], /^[A-Z]/.test(m[1]) && /\.(t|j)sx$/.test("") ? "component" : "function", i, exported);
    else if ((m = l.match(/^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/)))
      push(m[1], "class", i, exported);
    else if ((m = l.match(/^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/)))
      push(m[1], "interface", i, exported);
    else if ((m = l.match(/^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*=/)))
      push(m[1], "type", i, exported);
    else if ((m = l.match(/^\s*(?:export\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/)))
      push(m[1], "enum", i, exported);
    else if ((m = l.match(/^\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]+)?=>/)))
      push(m[1], /^[A-Z]/.test(m[1]) ? "component" : "function", i, exported);
    else if ((m = l.match(/^\s*export\s+const\s+([A-Za-z_$][\w$]*)/)))
      push(m[1], "const", i, true);
    else if ((m = l.match(/^\s*export\s+default\s+([A-Za-z_$][\w$]*)\s*;?\s*$/)))
      push(m[1], "export", i, true);
  }
  return out;
}

function tsImports(lines: string[], fromPath: string): ExtractedImport[] {
  const out: ExtractedImport[] = [];
  for (const l of lines) {
    // import { a, b as c } from 'x' | import d from 'x' | import * as ns from 'x'
    const m = l.match(/^\s*import\s+(?:type\s+)?(.*?)\s+from\s+["']([^"']+)["']/)
           ?? l.match(/^\s*import\s+["']([^"']+)["']/)
           ?? l.match(/(?:require|import)\(\s*["']([^"']+)["']\s*\)/);
    if (!m) continue;
    const spec = m[2] ?? m[1];
    const clause = m[2] ? m[1] : "";
    const names: string[] = [];
    const braces = clause.match(/\{([^}]*)\}/)?.[1];
    if (braces) for (const part of braces.split(",")) {
      const n = part.trim().split(/\s+as\s+/)[0].replace(/^type\s+/, "").trim();
      if (n) names.push(n);
    }
    const def = clause.replace(/\{[^}]*\}/, "").replace(/\*\s+as\s+(\w+)/, "$1").replace(/,/g, "").trim();
    if (def && /^[A-Za-z_$][\w$]*$/.test(def)) names.push(def);
    out.push(resolveImport(spec, names, fromPath, ["ts", "tsx", "js", "jsx", "mjs", "index.ts", "index.tsx", "index.js"]));
  }
  return out;
}

// --- Python ------------------------------------------------------------------------

function pySymbols(lines: string[]): ExtractedSymbol[] {
  const out: ExtractedSymbol[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    let m: RegExpMatchArray | null;
    if ((m = l.match(/^(\s*)(?:async\s+)?def\s+([A-Za-z_]\w*)/))) {
      out.push({ name: m[2], kind: m[1] ? "method" : "function", line: i + 1, signature: sig(l), exported: !m[2].startsWith("_") });
    } else if ((m = l.match(/^class\s+([A-Za-z_]\w*)/))) {
      out.push({ name: m[1], kind: "class", line: i + 1, signature: sig(l), exported: !m[1].startsWith("_") });
    } else if ((m = l.match(/^([A-Z][A-Z0-9_]+)\s*=/))) {
      out.push({ name: m[1], kind: "const", line: i + 1, signature: sig(l), exported: true });
    }
  }
  return out;
}

function pyImports(lines: string[], fromPath: string): ExtractedImport[] {
  const out: ExtractedImport[] = [];
  for (const l of lines) {
    let m: RegExpMatchArray | null;
    if ((m = l.match(/^\s*from\s+([\w.]+)\s+import\s+(.+)/))) {
      const names = m[2].split(",").map((p) => p.trim().split(/\s+as\s+/)[0].trim()).filter((n) => n && n !== "*");
      const spec = m[1];
      const rel = spec.startsWith(".");
      out.push({
        spec, names,
        resolved: rel ? resolvePyRelative(spec, fromPath) : null,
        external: !rel,
      });
    } else if ((m = l.match(/^\s*import\s+([\w.]+(?:\s*,\s*[\w.]+)*)/))) {
      for (const spec of m[1].split(",").map((s) => s.trim().split(/\s+as\s+/)[0])) {
        out.push({ spec, names: [], resolved: null, external: true });
      }
    }
  }
  return out;
}

function resolvePyRelative(spec: string, fromPath: string): string {
  const up = (spec.match(/^\.+/)?.[0].length ?? 1) - 1;
  const dir = fromPath.split("/").slice(0, -(1 + up)).join("/");
  const tail = spec.replace(/^\.+/, "").split(".").filter(Boolean).join("/");
  return `${dir ? dir + "/" : ""}${tail}.py`;
}

// --- PHP ----------------------------------------------------------------------------

function phpSymbols(lines: string[]): ExtractedSymbol[] {
  const out: ExtractedSymbol[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    let m: RegExpMatchArray | null;
    if ((m = l.match(/^\s*(?:final\s+|abstract\s+)?class\s+(\w+)/)))
      out.push({ name: m[1], kind: "class", line: i + 1, signature: sig(l), exported: true });
    else if ((m = l.match(/^\s*interface\s+(\w+)/)))
      out.push({ name: m[1], kind: "interface", line: i + 1, signature: sig(l), exported: true });
    else if ((m = l.match(/^\s*trait\s+(\w+)/)))
      out.push({ name: m[1], kind: "trait", line: i + 1, signature: sig(l), exported: true });
    else if ((m = l.match(/^\s*(?:(?:public|private|protected|static)\s+)*function\s+(\w+)/)))
      out.push({ name: m[1], kind: /^\s*function/.test(l) ? "function" : "method", line: i + 1, signature: sig(l), exported: !/private|protected/.test(l) });
  }
  return out;
}

function phpImports(lines: string[]): ExtractedImport[] {
  const out: ExtractedImport[] = [];
  for (const l of lines) {
    const m = l.match(/^\s*use\s+([\w\\]+)(?:\s+as\s+(\w+))?\s*;/);
    if (m) {
      const parts = m[1].split("\\");
      out.push({ spec: m[1], names: [m[2] ?? parts[parts.length - 1]], resolved: null, external: true });
    }
  }
  return out;
}

// --- Go -------------------------------------------------------------------------------

function goSymbols(lines: string[]): ExtractedSymbol[] {
  const out: ExtractedSymbol[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    let m: RegExpMatchArray | null;
    if ((m = l.match(/^func\s+(?:\([^)]+\)\s+)?(\w+)/)))
      out.push({ name: m[1], kind: /^func\s+\(/.test(l) ? "method" : "function", line: i + 1, signature: sig(l), exported: /^[A-Z]/.test(m[1]) });
    else if ((m = l.match(/^type\s+(\w+)\s+struct/)))
      out.push({ name: m[1], kind: "struct", line: i + 1, signature: sig(l), exported: /^[A-Z]/.test(m[1]) });
    else if ((m = l.match(/^type\s+(\w+)\s+interface/)))
      out.push({ name: m[1], kind: "interface", line: i + 1, signature: sig(l), exported: /^[A-Z]/.test(m[1]) });
    else if ((m = l.match(/^(?:var|const)\s+(\w+)/)))
      out.push({ name: m[1], kind: "const", line: i + 1, signature: sig(l), exported: /^[A-Z]/.test(m[1]) });
  }
  return out;
}

function goImports(lines: string[]): ExtractedImport[] {
  const out: ExtractedImport[] = [];
  let inBlock = false;
  for (const l of lines) {
    if (/^import\s*\(/.test(l)) { inBlock = true; continue; }
    if (inBlock && /^\)/.test(l)) { inBlock = false; continue; }
    const m = inBlock
      ? l.match(/^\s*(?:\w+\s+)?"([^"]+)"/)
      : l.match(/^import\s+(?:\w+\s+)?"([^"]+)"/);
    if (m) out.push({ spec: m[1], names: [], resolved: null, external: true });
  }
  return out;
}

// --- Rust ------------------------------------------------------------------------------

function rsSymbols(lines: string[]): ExtractedSymbol[] {
  const out: ExtractedSymbol[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    let m: RegExpMatchArray | null;
    const pub = /^\s*pub(\(.*\))?\s/.test(l);
    if ((m = l.match(/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+(\w+)/)))
      out.push({ name: m[1], kind: "function", line: i + 1, signature: sig(l), exported: pub });
    else if ((m = l.match(/^\s*(?:pub(?:\([^)]*\))?\s+)?struct\s+(\w+)/)))
      out.push({ name: m[1], kind: "struct", line: i + 1, signature: sig(l), exported: pub });
    else if ((m = l.match(/^\s*(?:pub(?:\([^)]*\))?\s+)?trait\s+(\w+)/)))
      out.push({ name: m[1], kind: "trait", line: i + 1, signature: sig(l), exported: pub });
    else if ((m = l.match(/^\s*(?:pub(?:\([^)]*\))?\s+)?enum\s+(\w+)/)))
      out.push({ name: m[1], kind: "enum", line: i + 1, signature: sig(l), exported: pub });
    else if ((m = l.match(/^\s*impl(?:<[^>]*>)?\s+(\w+)/)))
      out.push({ name: m[1], kind: "impl", line: i + 1, signature: sig(l), exported: false });
    else if ((m = l.match(/^\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+(\w+)\s*[;{]/)))
      out.push({ name: m[1], kind: "module", line: i + 1, signature: sig(l), exported: pub });
  }
  return out;
}

function rsImports(lines: string[]): ExtractedImport[] {
  const out: ExtractedImport[] = [];
  for (const l of lines) {
    const m = l.match(/^\s*use\s+([\w:]+)(?:::\{([^}]*)\})?/);
    if (!m) continue;
    const names = m[2] ? m[2].split(",").map((s) => s.trim().split(/\s+as\s+/)[0]).filter(Boolean)
                       : [m[1].split("::").pop()!];
    const external = !m[1].startsWith("crate") && !m[1].startsWith("super") && !m[1].startsWith("self");
    out.push({ spec: m[1], names, resolved: null, external });
  }
  return out;
}

// --- shared resolution -----------------------------------------------------------------

function resolveImport(
  spec: string, names: string[], fromPath: string, candidates: string[],
): ExtractedImport {
  if (!spec.startsWith(".")) return { spec, names, resolved: null, external: true };
  const dir = fromPath.split("/").slice(0, -1);
  const parts = spec.split("/");
  const stack = [...dir];
  for (const p of parts) {
    if (p === "." || p === "") continue;
    else if (p === "..") stack.pop();
    else stack.push(p);
  }
  const base = stack.join("/");
  // We can't stat files here, so record the most likely candidate; github-sync
  // post-resolves against the actual indexed file list.
  return { spec, names, resolved: base, external: false, } as ExtractedImport & { candidates?: string[] };
}

/** Given the unresolved base ('src/lib/auth') and the set of indexed paths,
 *  pick the real file ('src/lib/auth.ts' | '.../index.ts' | exact). */
export function resolveAgainstIndex(base: string, indexedPaths: Set<string>): string | null {
  if (indexedPaths.has(base)) return base;
  for (const ext of ["ts", "tsx", "js", "jsx", "mjs", "py", "php", "go", "rs"]) {
    if (indexedPaths.has(`${base}.${ext}`)) return `${base}.${ext}`;
  }
  for (const idx of ["index.ts", "index.tsx", "index.js", "__init__.py", "mod.rs"]) {
    if (indexedPaths.has(`${base}/${idx}`)) return `${base}/${idx}`;
  }
  return null;
}
