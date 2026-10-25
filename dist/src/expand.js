import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { SR_DIR } from "./paths.js";
import { bareSkill } from "./state.js";
/**
 * Description expansion: for each skill a local model writes three requests a user might type and six keywords, which are
 * appended to the skill's text before it is embedded. Descriptions say what a skill is; people ask for what they want done,
 * in other words. Measured on the 245-prompt live set, product code, scratch indexes, nothing else changed: over the whole
 * 4,617-skill library the right skill ranked first 87% -> 90%, hints on prompts that need no skill 32% -> 27% (14 prompts
 * fixed, 6 new), recall 72% -> 72%, precision 63% -> 60%. That is a small gain on a small set, not a clear win. Over the 1,739
 * skills the prompts can land on it looked larger (false hints 31% -> 23%), which is the risk of testing on a partial library.
 * Replacing the description with a rewrite ranked worse, and feeding the expansion to BM25 ranked much worse (top-1 -6 to -9
 * points), so only the vectors see it. Skill files are never edited: the expansions live in one file next to the index.
 */
export const EXPANSION_FILE = path.join(SR_DIR, "expansions.jsonl");
/** Part of every key: a new prompt or shape bumps it, and the old rows stop matching instead of being served. */
export const EXPANSION_VERSION = 2;
/** What the model sees of a skill file besides its description: the first 250 characters after the frontmatter. */
export const openingOf = (fileText) => fileText.slice(0, 6000).replace(/^---[\s\S]*?---/, "").replace(/\s+/g, " ").trim().slice(0, 250);
/** A rewrite belongs to one description and opening; copies of a skill under other names share it, an edited skill gets a new one. */
export const expansionKey = (description, opening) => crypto.createHash("sha1").update(`${EXPANSION_VERSION}|${description.trim()}|${opening}`).digest("hex").slice(0, 16);
const words = (xs, n, max) => (Array.isArray(xs) ? xs : []).map((x) => String(x ?? "").replace(/\s+/g, " ").trim().slice(0, max)).filter(Boolean).slice(0, n);
/** The stored expansions by key. A bad line, or a row without queries or keywords, is skipped; the last row for a key wins. */
export function readExpansions(file = EXPANSION_FILE) {
    const out = new Map();
    let text = "";
    try {
        text = fs.readFileSync(file, "utf8");
    }
    catch {
        return out;
    }
    for (const line of text.split("\n")) {
        if (!line.trim())
            continue;
        try {
            const r = JSON.parse(line);
            if (typeof r?.key !== "string" || r.error)
                continue;
            const queries = words(r.queries, 3, 90), keywords = words(r.keywords, 6, 30).map((k) => k.toLowerCase());
            if (queries.length || keywords.length)
                out.set(r.key, { queries, keywords });
        }
        catch { /* a bad line is skipped, not fatal */ }
    }
    return out;
}
/** The text appended to a skill's description before embedding. */
export const expansionText = (e) => [e.queries.length ? `Asked as: ${e.queries.join("; ")}.` : "", e.keywords.length ? e.keywords.join(", ") + "." : ""].filter(Boolean).join(" ");
const SCHEMA = {
    type: "object",
    properties: {
        does: { type: "string" },
        queries: { type: "array", items: { type: "string" }, maxItems: 3 },
        keywords: { type: "array", items: { type: "string" }, maxItems: 6 },
    },
    required: ["does", "queries", "keywords"],
};
// `does` is asked for but not kept: writing the one-line summary first is what keeps the model on the facts in the text,
// and the measurements above were made with exactly this prompt.
const prompt = (name, description, opening) => `You write search metadata for a library of agent skills. An agent reads it to decide whether to load a skill for a user's request.

Skill name: ${name}
Description: ${description || "(none)"}
Start of the skill file: ${opening || "(empty)"}

Write JSON with:
- does: what the skill does, one plain sentence of at most 12 words.
- queries: 3 requests a user might type to a coding agent that this skill should handle, each at most 12 words, in the user's own casual words, not copied from the description.
- keywords: up to 6 lowercase terms or synonyms a user might type (tools, file types, problems). Do not repeat the skill name.
Use only facts in the text above. Do not invent features.`;
const jobsOf = (index, have) => {
    const seen = new Set();
    const todo = [];
    let already = 0;
    for (const s of index.skills) {
        let opening = "";
        try {
            opening = openingOf(fs.readFileSync(path.join(s.path, "SKILL.md"), "utf8"));
        }
        catch { /* the description alone */ }
        const key = expansionKey(s.description, opening);
        if (seen.has(key))
            continue;
        seen.add(key);
        if (have.has(key))
            already++;
        else
            todo.push({ key, name: bareSkill(s.id), description: s.description.trim().slice(0, 500), opening });
    }
    return { todo, distinct: seen.size, already };
};
/**
 * Write the missing expansions for an index, one row per distinct (description, opening), appended as they finish so a stopped
 * run resumes where it was. A request that fails three times writes nothing, so the next run tries it again.
 */
export async function expandLibrary(index, options = {}) {
    const file = options.file ?? EXPANSION_FILE;
    const model = options.model ?? "qwen3:8b";
    const url = `${(options.url ?? "http://127.0.0.1:11434").replace(/\/+$/, "")}/api/chat`;
    const doFetch = options.fetchImpl ?? fetch;
    const { todo: all, distinct, already } = jobsOf(index, new Set(readExpansions(file).keys()));
    const todo = options.limit ? all.slice(0, options.limit) : all;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    let next = 0, written = 0, errors = 0;
    const one = async (j) => {
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                const r = await doFetch(url, {
                    method: "POST", headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ model, stream: false, think: false, keep_alive: "3h", format: SCHEMA, options: { temperature: 0, num_ctx: 2048, num_predict: 200 },
                        messages: [{ role: "user", content: prompt(j.name, j.description, j.opening) }] }),
                });
                if (!r.ok)
                    throw new Error(`HTTP ${r.status}`);
                const o = JSON.parse((await r.json()).message.content);
                const queries = words(o.queries, 3, 90), keywords = words(o.keywords, 6, 30).map((k) => k.toLowerCase());
                if (!queries.length && !keywords.length)
                    throw new Error("nothing usable");
                fs.appendFileSync(file, JSON.stringify({ key: j.key, v: EXPANSION_VERSION, model, name: j.name, queries, keywords }) + "\n");
                written++;
                return;
            }
            catch { /* retry */ }
        }
        errors++;
    };
    const worker = async () => {
        while (next < todo.length) {
            await one(todo[next++]);
            options.onProgress?.(written + errors, todo.length, errors);
        }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(16, options.concurrency ?? 4)) }, worker));
    return { distinct, already, written, errors };
}
/** How many of an index's skills have an expansion that still matches their text, and how many stored rows match nothing now. */
export function expansionCoverage(index, file = EXPANSION_FILE) {
    const rows = readExpansions(file);
    const live = new Set();
    let covered = 0;
    for (const s of index.skills) {
        let opening = "";
        try {
            opening = openingOf(fs.readFileSync(path.join(s.path, "SKILL.md"), "utf8"));
        }
        catch { /* the description alone */ }
        const key = expansionKey(s.description, opening);
        live.add(key);
        if (rows.has(key))
            covered++;
    }
    return { skills: index.skills.length, covered, rows: rows.size, stale: [...rows.keys()].filter((k) => !live.has(k)).length };
}
