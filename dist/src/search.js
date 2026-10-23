import fs from "node:fs";
import path from "node:path";
import { BM25, tokenize, stem, TOKENIZER_VERSION } from "./bm25.js";
import { loadIndex } from "./index.js";
import { USAGE_LOG, SR_DIR } from "./paths.js";
import { semanticScores } from "./embed.js";
let cached = null;
export function getIndex() {
    if (cached)
        return cached;
    const index = loadIndex();
    if (!index)
        throw new Error("No index yet. Run: skillrouter index");
    // An index from an older tokenizer still works: its stored tokens get the same stemming queries get.
    const tokens = (s) => ((index.tokenizer ?? 1) < TOKENIZER_VERSION ? s.tokens.map(stem) : s.tokens);
    cached = { index, bm25: new BM25(index.skills.map((s) => ({ id: s.id, tokens: tokens(s), name: tokenize(s.name) }))) };
    return cached;
}
/**
 * BM25 by default. With vectors (skillrouter index --embeddings) and the model installed, each hit also
 * carries its cosine to the query, semantic-only candidates join, and the ranking blends both.
 * `cos` is undefined when no semantic layer ran.
 */
export async function search(query, k = 5, options = {}) {
    const { index, bm25 } = getIndex();
    const byId = new Map(index.skills.map((s) => [s.id, s]));
    const lexical = bm25.search(query, k * 3);
    const scores = new Map(lexical.map((h) => [h.id, h.score]));
    const raws = new Map(lexical.map((h) => [h.id, h.raw]));
    const matched = new Map(lexical.map((h) => [h.id, h.matched]));
    const sem = options.semantic !== undefined ? options.semantic : options.lexicalOnly ? null : (await semanticScores(query, 800, index.builtAt)).scores;
    if (sem) {
        const top = [...sem.entries()].sort((a, b) => b[1] - a[1]).slice(0, k * 2);
        for (const [id] of top)
            if (!scores.has(id) && byId.has(id))
                scores.set(id, 0);
        for (const id of scores.keys())
            scores.set(id, 0.5 * (scores.get(id) ?? 0) + 0.5 * Math.max(0, sem.get(id) ?? 0) / Math.max(1e-9, top[0]?.[1] ?? 1));
    }
    // Collapse same-named variants (foo, foo~2 …): the library often holds several copies of one skill.
    const seenName = new Set();
    return [...scores.entries()]
        .sort((a, b) => b[1] - a[1])
        .filter(([id]) => { const n = byId.get(id).name; if (seenName.has(n))
        return false; seenName.add(n); return true; })
        .slice(0, k)
        .map(([id, score]) => ({ skill: byId.get(id), score: Math.round(score * 1000) / 1000, raw: Math.round((raws.get(id) ?? 0) * 100) / 100,
        // A skill missing from the vectors keeps cos undefined, so the lexical gate still judges it.
        matched: matched.get(id) ?? 0, cos: sem?.has(id) ? Math.round(sem.get(id) * 1000) / 1000 : undefined }));
}
export function findSkill(nameOrId) {
    const { index } = getIndex();
    const n = nameOrId.trim().toLowerCase();
    const exact = index.skills.filter((s) => s.id.toLowerCase() === n);
    if (exact.length)
        return exact;
    return index.skills.filter((s) => s.name.toLowerCase() === n || path.basename(s.path).toLowerCase() === n);
}
export function readSkill(skill) {
    return fs.readFileSync(path.join(skill.path, "SKILL.md"), "utf8");
}
/** One JSON line per event. Prompt text is never logged; queries written by the model are. */
export function logUsage(event) {
    try {
        fs.mkdirSync(SR_DIR, { recursive: true });
        fs.appendFileSync(USAGE_LOG, JSON.stringify({ ts: new Date().toISOString(), ...event }) + "\n");
    }
    catch { /* never block a tool on logging */ }
}
