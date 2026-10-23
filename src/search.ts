import fs from "node:fs";
import path from "node:path";
import { BM25, tokenize, stem, TOKENIZER_VERSION } from "./bm25.js";
import { loadIndex, type Index, type SkillEntry } from "./index.js";
import { USAGE_LOG, SR_DIR } from "./paths.js";

export interface Hit { skill: SkillEntry; score: number; raw: number; matched: number }

let cached: { index: Index; bm25: BM25 } | null = null;

export function getIndex(): { index: Index; bm25: BM25 } {
  if (cached) return cached;
  const index = loadIndex();
  if (!index) throw new Error("No index yet. Run: skillrouter index");
  // An index from an older tokenizer still works: its stored tokens get the same stemming queries get.
  const tokens = (s: SkillEntry) => ((index.tokenizer ?? 1) < TOKENIZER_VERSION ? s.tokens.map(stem) : s.tokens);
  cached = { index, bm25: new BM25(index.skills.map((s) => ({ id: s.id, tokens: tokens(s), name: tokenize(s.name) }))) };
  return cached;
}

/** BM25 by default. With an embeddings index (skillrouter index --embeddings) and the model installed, blends both. */
export async function search(query: string, k = 5, options: { lexicalOnly?: boolean } = {}): Promise<Hit[]> {
  const { index, bm25 } = getIndex();
  const byId = new Map(index.skills.map((s) => [s.id, s]));
  const lexical = bm25.search(query, k * 3);
  const scores = new Map(lexical.map((h) => [h.id, h.score]));
  const raws = new Map(lexical.map((h) => [h.id, h.raw]));
  const matched = new Map(lexical.map((h) => [h.id, h.matched]));
  if (index.embeddings && !options.lexicalOnly) {
    const q = await embed([query]).catch(() => null);
    if (q) {
      const sem = cosineTop(q[0], index.embeddings, k * 2);
      for (const [id, s] of sem) scores.set(id, Math.max(scores.get(id) ?? 0, s) * 0.5 + ((scores.get(id) ?? 0) + s) * 0.25);
    }
  }
  // Collapse same-named variants (foo, foo~2 …): the library often holds several copies of one skill.
  const seenName = new Set<string>();
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .filter(([id]) => { const n = byId.get(id)!.name; if (seenName.has(n)) return false; seenName.add(n); return true; })
    .slice(0, k)
    .map(([id, score]) => ({ skill: byId.get(id)!, score: Math.round(score * 1000) / 1000, raw: Math.round((raws.get(id) ?? 0) * 100) / 100, matched: matched.get(id) ?? 0 }));
}

export function findSkill(nameOrId: string): SkillEntry[] {
  const { index } = getIndex();
  const n = nameOrId.trim().toLowerCase();
  const exact = index.skills.filter((s) => s.id.toLowerCase() === n);
  if (exact.length) return exact;
  return index.skills.filter((s) => s.name.toLowerCase() === n || path.basename(s.path).toLowerCase() === n);
}

export function readSkill(skill: SkillEntry): string {
  return fs.readFileSync(path.join(skill.path, "SKILL.md"), "utf8");
}

/** One JSON line per event. Prompt text is never logged; queries written by the model are. */
export function logUsage(event: Record<string, unknown>): void {
  try {
    fs.mkdirSync(SR_DIR, { recursive: true });
    fs.appendFileSync(USAGE_LOG, JSON.stringify({ ts: new Date().toISOString(), ...event }) + "\n");
  } catch { /* never block a tool on logging */ }
}

// --- optional embeddings (needs: pnpm add @huggingface/transformers, then skillrouter index --embeddings)
let pipe: ((t: string[], o: object) => Promise<{ tolist(): number[][] }>) | null = null;
export async function embed(texts: string[]): Promise<number[][]> {
  if (!pipe) {
    const mod = await import("@huggingface/transformers" as string).catch(() => {
      throw new Error("Embeddings need @huggingface/transformers. Install it next to skillrouter or stay on BM25.");
    });
    pipe = await mod.pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2");
  }
  const out = await pipe!(texts, { pooling: "mean", normalize: true });
  return out.tolist();
}

function cosineTop(q: number[], all: Record<string, number[]>, k: number): [string, number][] {
  const res: [string, number][] = [];
  for (const [id, v] of Object.entries(all)) {
    let s = 0;
    for (let i = 0; i < q.length; i++) s += q[i] * v[i];
    res.push([id, s]);
  }
  return res.sort((a, b) => b[1] - a[1]).slice(0, k);
}
