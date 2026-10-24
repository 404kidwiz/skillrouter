import fs from "node:fs";
import { search, getIndex, duplicateKind } from "./search.js";
import { isConversational, isSystemText, minRawFor, selectHints } from "./hint.js";
import { coreIds } from "./core.js";
import { bareSkill } from "./state.js";
import { loadVectors } from "./embed.js";
/** Floors the CI gate enforces. Calibrated on the fixture; `--min-*`/`--max-*` flags override. */
export const DEFAULT_THRESHOLDS = { top1: 0.85, top3: 0.9, hintRecall: 0.85, hintPrecision: 0.7, falseHints: 0.1, copiesShown: 0 };
export function readCases(file) {
    let text = "";
    try {
        text = fs.readFileSync(file, "utf8");
    }
    catch {
        return [];
    }
    const out = [];
    for (const line of text.split("\n")) {
        if (!line.trim() || line.trim().startsWith("#"))
            continue;
        try {
            const c = JSON.parse(line);
            if (typeof c?.prompt === "string" && Array.isArray(c.expect))
                out.push({ prompt: c.prompt, expect: c.expect.map(String) });
        }
        catch { /* a bad line is skipped, not fatal */ }
    }
    return out;
}
export async function evaluate(cases, options = {}) {
    const { index } = getIndex();
    const vectors = loadVectors();
    const lexicalOnly = options.lexicalOnly || !vectors || vectors.indexBuiltAt !== index.builtAt;
    const minRaw = options.minRaw ?? minRawFor(index.skills.length);
    const byId = new Map(index.skills.map((s) => [s.id, s]));
    const k = options.k ?? 3;
    const prefer = coreIds();
    const rows = [];
    for (const c of cases) {
        const hits = await search(c.prompt.slice(0, 1000), 12, { lexicalOnly, prefer });
        // The prompt check skips commands, system turns and very short prompts before searching; so does the eval.
        const skipped = c.prompt.trim().startsWith("/") || isSystemText(c.prompt) || c.prompt.trim().length < 20;
        const shown = skipped ? [] : selectHints(hits, minRaw, k, { conversational: isConversational(c.prompt) });
        const want = new Set(c.expect.map(bareSkill));
        // An expected skill, or a copy of one (same text under another name): the agent would read the same instructions.
        const ok = (id) => want.has(bareSkill(id)) || c.expect.some((e) => { const a = byId.get(e), b = byId.get(id); return !!a && !!b && duplicateKind(a, b, null) === "copy"; });
        let copies = 0;
        for (let i = 0; i < shown.length; i++)
            for (let j = i + 1; j < shown.length; j++)
                if (duplicateKind(shown[i].skill, shown[j].skill, lexicalOnly ? null : vectors) === "copy")
                    copies++;
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
    const rate = (xs, f) => (xs.length ? xs.filter(f).length / xs.length : 1);
    const shownPos = pos.flatMap((r) => r.shown.map((id) => r.expect.map(bareSkill).includes(bareSkill(id))));
    return { rows, summary: {
            mode: lexicalOnly ? "lexical" : "semantic", cases: rows.length, positives: pos.length, negatives: neg.length,
            top1: rate(pos, (r) => r.top1 === true), top3: rate(pos, (r) => r.top3 === true), hintRecall: rate(pos, (r) => r.recall === true),
            hintPrecision: shownPos.length ? shownPos.filter(Boolean).length / shownPos.length : 1,
            falseHints: rate(neg, (r) => r.falseHint === true), copiesShown: rows.reduce((n, r) => n + r.copies, 0),
        } };
}
const pct = (x) => `${Math.round(x * 100)}%`;
export function formatEval({ rows, summary: s }, verbose = false) {
    const out = [
        `Eval (${s.mode}): ${s.cases} prompts, ${s.positives} expecting a skill, ${s.negatives} expecting none.`,
        `  top-1 ${pct(s.top1)}   top-3 ${pct(s.top3)}   hint recall ${pct(s.hintRecall)}   hint precision ${pct(s.hintPrecision)}   false hints ${pct(s.falseHints)}   copies shown ${s.copiesShown}`,
    ];
    const misses = rows.filter((r) => r.top1 === false || r.recall === false || r.falseHint === true || r.copies > 0);
    const show = verbose ? rows : misses;
    if (show.length)
        out.push(verbose ? "All cases:" : "Misses:");
    for (const r of show) {
        const why = r.falseHint ? "false hint" : r.top1 === false && r.recall === false ? "missed" : r.top1 === false ? "not top-1" : r.recall === false ? "not hinted" : r.copies ? "copies" : "ok";
        out.push(`  [${why}] ${r.prompt.slice(0, 70)}`, `      expect ${r.expect.join(", ") || "none"} | top ${r.top.join(", ") || "-"} | shown ${r.shown.join(", ") || "-"}`);
    }
    return out.join("\n");
}
const FILLER_DOMAINS = {
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
export function writeFillers(dir, count = 400, seed = 7) {
    let x = seed >>> 0;
    const rand = () => { x = (x + 0x6d2b79f5) >>> 0; let t = x; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const pick = (words, n) => { const pool = [...words]; const out = []; while (out.length < n && pool.length)
        out.push(pool.splice(Math.floor(rand() * pool.length), 1)[0]); return out; };
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
export function checkThresholds(s, t = DEFAULT_THRESHOLDS) {
    const out = [];
    const floor = (name, v) => { if (v < t[name])
        out.push(`${name} ${pct(v)} is below the floor of ${pct(t[name])}`); };
    floor("top1", s.top1);
    floor("top3", s.top3);
    floor("hintRecall", s.hintRecall);
    floor("hintPrecision", s.hintPrecision);
    if (s.falseHints > t.falseHints)
        out.push(`falseHints ${pct(s.falseHints)} is above the ceiling of ${pct(t.falseHints)}`);
    if (s.copiesShown > t.copiesShown)
        out.push(`copiesShown ${s.copiesShown} is above the ceiling of ${t.copiesShown}`);
    return out;
}
/** Append a labeled prompt to a live eval file. `expect` is "none" or a comma-separated list of ids. */
export function addCase(file, prompt, expect) {
    const c = { prompt: prompt.trim(), expect: expect.trim().toLowerCase() === "none" ? [] : expect.split(",").map((s) => s.trim()).filter(Boolean) };
    fs.mkdirSync(require_dir(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(c) + "\n");
    return c;
}
function require_dir(file) { return file.replace(/[\\/][^\\/]*$/, "") || "."; }
