import fs from "node:fs";
import { search, getIndex, duplicateKind, findSkill } from "./search.js";
import { isConversational, isSlashCommand, isSystemText, minRawFor, selectHints } from "./hint.js";
import { coreIds } from "./core.js";
import { bareSkill } from "./state.js";
import { loadVectors } from "./embed.js";

/**
 * Routing quality on labeled prompts, measured the way the prompt check works: the ranked search and the
 * hint gate (`selectHints`). A case expects one or more skill ids (any of them counts), or none, meaning a
 * hint would be noise. The repo ships a fixture library and prompts under eval/ for CI; `--live` runs the
 * same metrics against the real index and ~/.skillrouter/eval.jsonl.
 */
export interface EvalCase { prompt: string; expect: string[] }

export interface EvalRow {
  prompt: string; expect: string[]; top: string[]; shown: string[];
  top1: boolean | null; top3: boolean | null; recall: boolean | null; falseHint: boolean | null; copies: number;
}

export interface EvalSummary {
  mode: "lexical" | "semantic"; cases: number; positives: number; negatives: number;
  top1: number; top3: number; hintRecall: number; hintPrecision: number; falseHints: number; copiesShown: number;
}

/** Floors the CI gate enforces. Calibrated on the fixture; `--min-*`/`--max-*` flags override. */
export const DEFAULT_THRESHOLDS = { top1: 0.85, top3: 0.9, hintRecall: 0.85, hintPrecision: 0.7, falseHints: 0.1, copiesShown: 0 };

export function readCases(file: string): EvalCase[] {
  let text = "";
  try { text = fs.readFileSync(file, "utf8"); } catch { return []; }
  const out: EvalCase[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    try {
      const c = JSON.parse(line);
      if (typeof c?.prompt === "string" && Array.isArray(c.expect)) out.push({ prompt: c.prompt, expect: c.expect.map(String) });
    } catch { /* a bad line is skipped, not fatal */ }
  }
  return out;
}

export async function evaluate(cases: EvalCase[], options: { lexicalOnly?: boolean; minRaw?: number; k?: number } = {}): Promise<{ rows: EvalRow[]; summary: EvalSummary; unknownIds: string[] }> {
  const { index } = getIndex();
  const vectors = loadVectors();
  const lexicalOnly = options.lexicalOnly || !vectors || vectors.indexBuiltAt !== index.builtAt;
  const minRaw = options.minRaw ?? minRawFor(index.skills.length);
  const byId = new Map(index.skills.map((s) => [s.id, s]));
  const k = options.k ?? 3;
  const prefer = coreIds();
  const rows: EvalRow[] = [];
  const expectedCache = new Map<string, ReturnType<typeof findSkill>>();
  const resolveExpected = (id: string) => {
    const cached = expectedCache.get(id);
    if (cached) return cached;
    const found = findSkill(id);
    if (found.length || Object.hasOwn(index.identityAliases ?? {}, id) || !/~\d+$/.test(id)) {
      expectedCache.set(id, found);
      return found;
    }
    const family = index.skills.filter(s => bareSkill(s.id) === bareSkill(id));
    expectedCache.set(id, family);
    return family;
  };
  const equivalent = (expected: string[], id: string) => {
    const b = byId.get(id);
    return expected.some(e => resolveExpected(e).some(a => a.id === id || (!!b && duplicateKind(a, b, null) === "copy")));
  };
  for (const c of cases) {
    const hits = await search(c.prompt.slice(0, 1000), 12, { lexicalOnly, prefer });
    // The prompt check skips commands, system turns and very short prompts before searching; so does the eval.
    const skipped = isSlashCommand(c.prompt.trim()) || isSystemText(c.prompt) || c.prompt.trim().length < 20;
    const shown = skipped ? [] : selectHints(hits, minRaw, k, { conversational: isConversational(c.prompt) });
    const ok = (id: string) => equivalent(c.expect, id);
    let copies = 0;
    for (let i = 0; i < shown.length; i++) for (let j = i + 1; j < shown.length; j++) if (duplicateKind(shown[i].skill, shown[j].skill, lexicalOnly ? null : vectors) === "copy") copies++;
    const positive = c.expect.length > 0;
    rows.push({
      prompt: c.prompt, expect: c.expect, top: hits.slice(0, 3).map((h) => h.skill.id), shown: shown.map((h) => h.skill.id),
      top1: positive ? !!hits[0] && ok(hits[0].skill.id) : null,
      top3: positive ? hits.slice(0, 3).some((h) => ok(h.skill.id)) : null,
      recall: positive ? shown.some((h) => ok(h.skill.id)) : null,
      falseHint: positive ? null : shown.length > 0,
      copies,
    });
  }
  const pos = rows.filter((r) => r.expect.length), neg = rows.filter((r) => !r.expect.length);
  const rate = (xs: EvalRow[], f: (r: EvalRow) => boolean | null) => (xs.length ? xs.filter(f).length / xs.length : 1);
  const shownPos = pos.flatMap((r) => r.shown.map((id) => equivalent(r.expect, id)));
  // A mistyped or since-removed id makes a positive that can never pass; say so instead of counting it as a miss.
  const unknownIds = [...new Set(cases.flatMap((c) => c.expect).filter((id) => !resolveExpected(id).length))];
  return { rows, unknownIds, summary: {
    mode: lexicalOnly ? "lexical" : "semantic", cases: rows.length, positives: pos.length, negatives: neg.length,
    top1: rate(pos, (r) => r.top1 === true), top3: rate(pos, (r) => r.top3 === true), hintRecall: rate(pos, (r) => r.recall === true),
    hintPrecision: shownPos.length ? shownPos.filter(Boolean).length / shownPos.length : 1,
    falseHints: rate(neg, (r) => r.falseHint === true), copiesShown: rows.reduce((n, r) => n + r.copies, 0),
  } };
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

export function formatEval({ rows, summary: s, unknownIds = [] }: { rows: EvalRow[]; summary: EvalSummary; unknownIds?: string[] }, verbose = false): string {
  const out = [
    `Eval (${s.mode}): ${s.cases} prompts, ${s.positives} expecting a skill, ${s.negatives} expecting none.`,
    `  top-1 ${pct(s.top1)}   top-3 ${pct(s.top3)}   hint recall ${pct(s.hintRecall)}   hint precision ${pct(s.hintPrecision)}   false hints ${pct(s.falseHints)}   copies shown ${s.copiesShown}`,
  ];
  if (unknownIds.length) out.push(`  Not in the index (a case expecting only these cannot pass): ${unknownIds.slice(0, 8).join(", ")}${unknownIds.length > 8 ? `, and ${unknownIds.length - 8} more` : ""}`);
  const misses = rows.filter((r) => r.top1 === false || r.recall === false || r.falseHint === true || r.copies > 0);
  const show = verbose ? rows : misses;
  if (show.length) out.push(verbose ? "All cases:" : "Misses:");
  for (const r of show) {
    const why = r.falseHint ? "false hint" : r.top1 === false && r.recall === false ? "missed" : r.top1 === false ? "not top-1" : r.recall === false ? "not hinted" : r.copies ? "copies" : "ok";
    out.push(`  [${why}] ${r.prompt.slice(0, 70)}`, `      expect ${r.expect.join(", ") || "none"} | top ${r.top.join(", ") || "-"} | shown ${r.shown.join(", ") || "-"}`);
  }
  return out.join("\n");
}

const FILLER_DOMAINS: Record<string, string> = {
  cooking: "sourdough starter hydration proofing crumb oven steam scoring bannetons lamination brioche ganache tempering emulsify braise deglaze",
  astronomy: "telescope aperture eyepiece nebula galaxy magnitude ecliptic occultation parallax spectrograph exoplanet transit albedo",
  gardening: "compost mulch perennial pruning trellis germination seedling transplant loam drainage pollinator cultivar rootstock",
  knitting: "cast-on purl gauge swatch yarn skein cable stitch blocking selvedge raglan colorwork intarsia",
  chess: "opening gambit endgame zugzwang castling fianchetto tempo blunder tactics pin fork skewer",
  sailing: "halyard jib tack gybe keel mainsail reef mooring tide knot bearing leeward windward",
  pottery: "kiln glaze bisque wheel throwing slip trimming firing stoneware porcelain kneading wedging",
  birding: "plumage migration warbler raptor binoculars fieldmark lifer thrush finch molt talon nesting",
  woodworking: "dovetail chisel plane mortise tenon grain jointer sanding finish varnish clamp sawdust",
  darkroom: "developer fixer enlarger aperture shutter negative emulsion grain contact-sheet safelight",
};

/**
 * Unrelated filler skills, generated deterministically into `dir`: BM25 weighs a term by how rare it is in the
 * library, so a 47-skill fixture would score nothing like a 4,500-skill one. 400 fillers in other domains bring
 * term rarity, and the size-scaled floor, into a realistic range without 400 files in the repo.
 */
export function writeFillers(dir: string, count = 400, seed = 7): number {
  let x = seed >>> 0;
  const rand = () => { x = (x + 0x6d2b79f5) >>> 0; let t = x; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const pick = (words: string[], n: number) => { const pool = [...words]; const out: string[] = []; while (out.length < n && pool.length) out.push(pool.splice(Math.floor(rand() * pool.length), 1)[0]); return out; };
  const domains = Object.keys(FILLER_DOMAINS);
  for (let i = 0; i < count; i++) {
    const domain = domains[i % domains.length];
    const words = FILLER_DOMAINS[domain].split(" ");
    const w = pick(words, 6);
    const id = `${domain}-${String(i).padStart(3, "0")}`;
    const description = `${w[0][0].toUpperCase() + w[0].slice(1)} and ${w[1]} guidance for ${domain}: ${w[2]}, ${w[3]} and ${w[4]}. Use when working on ${w[5]} in ${domain}.`;
    fs.mkdirSync(`${dir}/${id}`, { recursive: true });
    fs.writeFileSync(`${dir}/${id}/SKILL.md`, `---\nname: ${id}\ndescription: ${description}\n---\n\n# ${id}\n\n${pick(words, 8).join(" ")}.\n`);
  }
  return count;
}

/** Threshold failures, as lines; empty when the run passes. */
export function checkThresholds(s: EvalSummary, t = DEFAULT_THRESHOLDS): string[] {
  const out: string[] = [];
  const floor = (name: keyof typeof t, v: number) => { if (v < t[name]) out.push(`${name} ${pct(v)} is below the floor of ${pct(t[name])}`); };
  floor("top1", s.top1); floor("top3", s.top3); floor("hintRecall", s.hintRecall); floor("hintPrecision", s.hintPrecision);
  if (s.falseHints > t.falseHints) out.push(`falseHints ${pct(s.falseHints)} is above the ceiling of ${pct(t.falseHints)}`);
  if (s.copiesShown > t.copiesShown) out.push(`copiesShown ${s.copiesShown} is above the ceiling of ${t.copiesShown}`);
  return out;
}

/** Append a labeled prompt to a live eval file. `expect` is "none" or a comma-separated list of ids. */
export function addCase(file: string, prompt: string, expect: string): EvalCase {
  const c: EvalCase = { prompt: prompt.trim(), expect: expect.trim().toLowerCase() === "none" ? [] : expect.split(",").map((s) => s.trim()).filter(Boolean) };
  fs.mkdirSync(require_dir(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(c) + "\n");
  return c;
}

function require_dir(file: string): string { return file.replace(/[\\/][^\\/]*$/, "") || "."; }
