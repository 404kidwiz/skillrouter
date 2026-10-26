import fs from "node:fs";
import path from "node:path";
import { BM25, tokenize, stem, TOKENIZER_VERSION } from "./bm25.js";
import { loadIndex, resolveSkillReference, type Index, type SkillEntry } from "./index.js";
import { applicabilityReason } from "./applicability.js";
import { USAGE_LOG, SR_DIR } from "./paths.js";
import { bareSkill } from "./state.js";
import { loadVectors, semanticScores, type Vectors } from "./embed.js";

/** `similar`: skills folded into this one by meaning alone, named so a distinct sibling (reply / reply-all) is never lost. */
export interface Hit { skill: SkillEntry; score: number; raw: number; matched: number; /** matched words rare in the library (absent on hits built by hand) */ specific?: number; cos?: number; similar?: string[] }

/**
 * `known`: skills (bare names) already shown or loaded; they are left out, and so are their duplicates.
 * `prefer`: skill ids (the preloaded core, see `coreIds`) that take their cluster's slot from a copy ranked above them.
 */
export interface SearchTrace { id: string; reason: string; kept?: string }
export interface SearchOptions { trace?: SearchTrace[]; lexicalOnly?: boolean; semantic?: Map<string, number> | null; known?: Set<string>; prefer?: Set<string> }

let cached: { index: Index; bm25: BM25; byId: Map<string, SkillEntry>; byName: Map<string, SkillEntry[]> } | null = null;

/** Forget the loaded index (the warm service does this when index.json changes on disk). */
export function resetIndexCache(): void { cached = null; }

export function getIndex(): { index: Index; bm25: BM25; byId: Map<string, SkillEntry>; byName: Map<string, SkillEntry[]> } {
  if (cached) return cached;
  const index = loadIndex();
  if (!index) throw new Error("No index yet. Run: skillrouter index");
  // An index from an older tokenizer still works: its stored tokens get the same stemming queries get.
  const tokens = (s: SkillEntry) => ((index.tokenizer ?? 1) < TOKENIZER_VERSION ? s.tokens.map(stem) : s.tokens);
  const byName = new Map<string, SkillEntry[]>();
  for (const s of index.skills) byName.set(s.name, [...(byName.get(s.name) ?? []), s]);
  cached = { index, bm25: new BM25(index.skills.map((s) => ({ id: s.id, tokens: tokens(s), name: tokenize(s.name) }))), byId: new Map(index.skills.map((s) => [s.id, s])), byName };
  return cached;
}

/**
 * BM25 by default. With vectors (skillrouter index --embeddings) and the model installed, each hit also
 * carries its cosine to the query, semantic-only candidates join, and the ranking blends both.
 * `cos` is undefined when no semantic layer ran.
 */
export async function search(query: string, k = 5, options: SearchOptions = {}): Promise<Hit[]> {
  const { index, bm25, byId, byName } = getIndex();
  const lexical = bm25.search(query, k * 3);
  const scores = new Map(lexical.map((h) => [h.id, h.score]));
  const raws = new Map(lexical.map((h) => [h.id, h.raw]));
  const matched = new Map(lexical.map((h) => [h.id, h.matched]));
  const specific = new Map(lexical.map((h) => [h.id, h.specific]));
  const sem = options.semantic !== undefined ? options.semantic : options.lexicalOnly ? null : (await semanticScores(query, 800, index.builtAt)).scores;
  if (sem) {
    const top = [...sem.entries()].sort((a, b) => b[1] - a[1]).slice(0, k * 2);
    for (const [id] of top) if (!scores.has(id) && byId.has(id)) scores.set(id, 0);
    for (const id of scores.keys()) scores.set(id, 0.5 * (scores.get(id) ?? 0) + 0.5 * Math.max(0, sem.get(id) ?? 0) / Math.max(1e-9, top[0]?.[1] ?? 1));
  }
  // Collapse same-named variants (foo, foo~2 …) and near-duplicates (copied or overlapping skills under other
  // names): the library often holds several versions of one skill, and each copy shown is a wasted slot.
  const v = freshVectors(index);
  const known = options.known ?? new Set<string>();
  const prefer = options.prefer ?? new Set<string>();
  // A kept skill stands for all its same-named variants (a copy of claude-api~2 joins the claude-api cluster). Only the
  // candidate's own text is compared: a mislabeled variant (impeccable~3 holding frontend-design's text) must not
  // fold the real skill of that name into another cluster.
  const kindOf = (kept: SkillEntry, s: SkillEntry): "copy" | "similar" | null => {
    let found: "similar" | null = null;
    for (const x of byName.get(kept.name) ?? [kept]) {
      const kind = duplicateKind(x, s, v);
      if (kind === "copy") return kind;
      found ??= kind;
    }
    return found;
  };
  const isKnown = (s: SkillEntry) => known.has(bareSkill(s.id)) || known.has(bareSkill(s.name));
  // What the agent already has: its copies add nothing. Meaning-only siblings stay (reply-all after reply).
  const anchors = known.size ? index.skills.filter(isKnown) : [];
  // `ref` is the hit whose rank and metrics a cluster keeps, even when a preloaded copy takes the slot.
  const kept: { skill: SkillEntry; score: number; ref: string; similar: string[] }[] = [];
  for (const [id, score] of [...scores.entries()].sort((a, b) => b[1] - a[1])) {
    const s = byId.get(id)!;
    const excluded = applicabilityReason(s, query);
    if (excluded) { options.trace?.push({ id, reason: excluded }); continue; }
    if (isKnown(s) || anchors.some((a) => duplicateKind(a, s, v) === "copy")) { options.trace?.push({ id, reason: "already known or a copy of a loaded skill" }); continue; }
    const j = kept.findIndex((o) => o.skill.name === s.name || kindOf(o.skill, s));
    if (j < 0 && kept.length >= k) { options.trace?.push({ id, reason: "outside result limit" }); continue; }
    if (j < 0) { kept.push({ skill: s, score, ref: id, similar: [] }); continue; }
    const other = kept[j];
    const kind = other.skill.name === s.name ? "copy" : kindOf(other.skill, s);
    // A preloaded copy takes the slot (no read needed); among plain copies the shorter id is the original to name
    // (python-testing, not toolbox-x-python-testing); a meaning-only match is named, since it may be a distinct sibling.
    const preferred = (x: SkillEntry) => prefer.has(x.id);
    // Slot swaps go by the two skills' own texts, never by a shared name alone: a same-named variant holding other
    // text (impeccable~3 with frontend-design's) must not hand its cluster to the real skill of that name.
    const own = duplicateKind(other.skill, s, v);
    const priority = (x: SkillEntry) => x.provenance?.maintainedPriority ?? 0;
    const plainCopy = own === "copy" && !preferred(other.skill) &&
      (priority(s) > priority(other.skill) || (priority(s) === priority(other.skill) && s.id.length < other.skill.id.length));
    if ((preferred(s) && !preferred(other.skill) && own) || plainCopy) {
      // Earlier discarded copies now point to the new representative as well.
      for (const entry of options.trace ?? []) if (entry.kept === other.skill.id) entry.kept = s.id;
      options.trace?.push({ id: other.skill.id, kept: s.id, reason: `duplicate ${own ?? 'copy'}; preferred representative` });
      kept[j] = { ...other, skill: s, similar: own === "similar" ? [other.skill.id, ...other.similar] : other.similar };
    } else {
      options.trace?.push({ id, kept: other.skill.id, reason: `duplicate ${kind ?? 'copy'}` });
      if (kind === "similar" && !other.similar.includes(s.id)) other.similar.push(s.id);
    }
  }
  return kept.map(({ skill, score, ref, similar }) => ({ skill, score: Math.round(score * 1000) / 1000, raw: Math.round((raws.get(ref) ?? 0) * 100) / 100,
    // A skill missing from the vectors keeps cos undefined, so the lexical gate still judges it.
    matched: matched.get(ref) ?? 0, specific: specific.get(ref) ?? 0, cos: sem?.has(ref) ? Math.round(sem.get(ref)! * 1000) / 1000 : undefined,
    ...(similar.length ? { similar: similar.slice(0, 3) } : {}) }));
}

// Calibrated 2026-10-23 on a 4,500-skill library: overlapping pairs (python-testing / python-testing-patterns,
// terraform-module-library / terraform-infrastructure) score 0.90; related but distinct skills stay lower
// (git-advanced-workflows / git-advanced 0.84, kubernetes-deployment / kubernetes-operations 0.83, docker-patterns /
// docker-expert under 0.80). Copies whose names differ a lot (qa-only~3 / toolbox-…-qa-only) can score under 0.80,
// which is why the opening sentence is compared too.
export const DUPLICATE_COS = 0.9;

/** Vectors built for this index, or none: stale vectors could map an id to a different skill. */
function freshVectors(index: Index): Vectors | null {
  const v = loadVectors();
  return v && v.indexBuiltAt === index.builtAt ? v : null;
}

/** A skill description's first sentence, as words: copies of one skill keep it even when their names differ. */
const lead = (s: SkillEntry) => s.description.toLowerCase().split(/(?<=[.!?])\s/)[0].replace(/[^a-z0-9]+/g, " ").trim();

/**
 * "copy": the same opening sentence, long enough to be specific (6+ words) or with one name inside the other
 * (qa-only / toolbox-…-qa-only); short generic openings ("Development skill from …") don't count.
 * "similar": skill vectors at the calibrated cosine; the kept hit names it, because siblings like
 * gws-gmail-reply / gws-gmail-reply-all or keyvault keys / secrets also land there.
 */
export function duplicateKind(a: SkillEntry, b: SkillEntry, v: Vectors | null): "copy" | "similar" | null {
  const la = lead(a);
  if (la.length >= 20 && la === lead(b)) {
    const na = bareSkill(a.name), nb = bareSkill(b.name);
    const words = a.description.split(/(?<=[.!?])\s/)[0].trim().split(/\s+/).length; // as written: "everything-claude-code" is one word
    if (words >= 6 || na.includes(nb) || nb.includes(na)) return "copy";
  }
  const i = v?.index.get(a.id), j = v?.index.get(b.id);
  if (!v || i === undefined || j === undefined) return null;
  let dot = 0;
  for (let d = 0; d < v.dim; d++) dot += v.data[i * v.dim + d] * v.data[j * v.dim + d];
  return dot >= DUPLICATE_COS ? "similar" : null;
}

export const nearDuplicate = (a: SkillEntry, b: SkillEntry, v: Vectors | null): boolean => duplicateKind(a, b, v) !== null;

export function findSkill(nameOrId: string): SkillEntry[] {
  const { index } = getIndex();
  const n = nameOrId.trim().toLowerCase();
  const resolved = resolveSkillReference(index, nameOrId);
  if (resolved) return [resolved];
  if (Object.keys(index.identityAliases ?? {}).some(a => a.toLowerCase() === n)) return [];
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
