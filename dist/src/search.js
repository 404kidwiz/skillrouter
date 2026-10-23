import fs from "node:fs";
import path from "node:path";
import { BM25, tokenize, stem, TOKENIZER_VERSION } from "./bm25.js";
import { loadIndex } from "./index.js";
import { USAGE_LOG, SR_DIR } from "./paths.js";
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
/** BM25 by default. With an embeddings index (skillrouter index --embeddings) and the model installed, blends both. */
export async function search(query, k = 5, options = {}) {
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
            for (const [id, s] of sem)
                scores.set(id, Math.max(scores.get(id) ?? 0, s) * 0.5 + ((scores.get(id) ?? 0) + s) * 0.25);
        }
    }
    // Collapse same-named variants (foo, foo~2 …): the library often holds several copies of one skill.
    const seenName = new Set();
    return [...scores.entries()]
        .sort((a, b) => b[1] - a[1])
        .filter(([id]) => { const n = byId.get(id).name; if (seenName.has(n))
        return false; seenName.add(n); return true; })
        .slice(0, k)
        .map(([id, score]) => ({ skill: byId.get(id), score: Math.round(score * 1000) / 1000, raw: Math.round((raws.get(id) ?? 0) * 100) / 100, matched: matched.get(id) ?? 0 }));
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
// --- optional embeddings (needs: pnpm add @huggingface/transformers, then skillrouter index --embeddings)
let pipe = null;
export async function embed(texts) {
    if (!pipe) {
        const mod = await import("@huggingface/transformers").catch(() => {
            throw new Error("Embeddings need @huggingface/transformers. Install it next to skillrouter or stay on BM25.");
        });
        pipe = await mod.pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2");
    }
    const out = await pipe(texts, { pooling: "mean", normalize: true });
    return out.tolist();
}
function cosineTop(q, all, k) {
    const res = [];
    for (const [id, v] of Object.entries(all)) {
        let s = 0;
        for (let i = 0; i < q.length; i++)
            s += q[i] * v[i];
        res.push([id, s]);
    }
    return res.sort((a, b) => b[1] - a[1]).slice(0, k);
}
