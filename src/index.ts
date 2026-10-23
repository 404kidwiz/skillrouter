import fs from "node:fs";
import path from "node:path";
import { INDEX_FILE, SR_DIR, defaultRoots } from "./paths.js";
import { tokenize } from "./bm25.js";

export interface SkillEntry {
  /** Unique id: frontmatter name, or dir name, suffixed when duplicated. */
  id: string;
  name: string;
  description: string;
  /** Real path of the skill directory. */
  path: string;
  /** Root it was found under (first root wins for duplicates by real path). */
  root: string;
  tokens: string[];
}

export interface Index { builtAt: string; roots: string[]; skills: SkillEntry[]; embeddings?: Record<string, number[]> }

const SKIP = new Set(["node_modules", ".git", ".venv", "__pycache__", "dist"]);

export function parseFrontmatter(text: string): Record<string, string> {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const out: Record<string, string> = {};
  if (!m) return out;
  let key = "";
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (kv) {
      key = kv[1];
      out[key] = kv[2].replace(/^["'](.*)["']$/, "$1").replace(/^[>|][-+]?$/, "").trim();
    } else if (key && /^\s+\S/.test(line)) {
      out[key] = (out[key] + " " + line.trim()).trim(); // folded multi-line value
    }
  }
  return out;
}

function* walk(root: string, depth = 0): Generator<string> {
  if (depth > 6) return;
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return; }
  // A folder with SKILL.md is a skill; a scan root may also hold one at the top and still contain more below.
  if (entries.some((e) => e.name === "SKILL.md" && e.isFile())) { yield root; if (depth > 0) return; }
  for (const e of entries) {
    if (e.name.startsWith(".") || SKIP.has(e.name)) continue;
    const p = path.join(root, e.name);
    let isDir = e.isDirectory();
    if (e.isSymbolicLink()) { try { isDir = fs.statSync(p).isDirectory(); } catch { continue; } }
    if (isDir) yield* walk(p, depth + 1);
  }
}

export function buildIndex(extraRoots: string[] = []): Index {
  const roots = defaultRoots(extraRoots).filter((r) => fs.existsSync(r));
  const seen = new Map<string, SkillEntry>();
  const ids = new Map<string, number>();
  for (const root of roots) {
    for (const dir of walk(root)) {
      let real: string;
      try { real = fs.realpathSync(dir); } catch { continue; }
      if (seen.has(real)) continue;
      let text = "";
      try { text = fs.readFileSync(path.join(real, "SKILL.md"), "utf8").slice(0, 6000); } catch { continue; }
      const fm = parseFrontmatter(text);
      const name = (fm.name || path.basename(dir)).trim();
      const n = (ids.get(name) ?? 0) + 1;
      ids.set(name, n);
      const id = n === 1 ? name : `${name}~${n}`;
      const description = fm.description ?? "";
      // Name and description carry the routing signal; a little body helps with synonyms without drowning them.
      const body = text.replace(/^---[\s\S]*?---/, "").slice(0, 500);
      const head = `${name} ${description} `.repeat(3);
      seen.set(real, { id, name, description, path: real, root, tokens: tokenize(head + body) });
    }
  }
  return { builtAt: new Date().toISOString(), roots, skills: [...seen.values()] };
}

export function saveIndex(index: Index): void {
  fs.mkdirSync(SR_DIR, { recursive: true });
  const tmp = INDEX_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(index));
  fs.renameSync(tmp, INDEX_FILE);
}

export function loadIndex(): Index | null {
  try { return JSON.parse(fs.readFileSync(INDEX_FILE, "utf8")) as Index; } catch { return null; }
}
