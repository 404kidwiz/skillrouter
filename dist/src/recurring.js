import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { SR_DIR } from "./paths.js";
import { bareSkill, claim, promptKeyOf, setPromptKey } from "./state.js";
import { renameSyncRetry } from "./platform.js";
/**
 * What a request used last time. A scheduled job sends the same prompt every run; each run had to search again (and,
 * with the gate, was refused until it did) to arrive at the skill it used the run before. Here the prompt check
 * remembers, per request, which skills were loaded while answering it, and names them at once the next time the same
 * request comes in: loading one satisfies the gate, so the search is skipped only when its answer is already known.
 *
 * A request is identified by a hash of its text with case, spacing and numbers flattened (dates and counters change
 * between runs); the text itself is never stored. Skills are remembered once they were loaded in two different
 * sessions for that request. SKILLROUTER_RECURRING=0 turns it off; `skillrouter recurring` lists what is remembered.
 */
const FILE = () => path.join(SR_DIR, "recurring.json");
const MAX_PROMPTS = 2000;
export const recurringEnabled = () => process.env.SKILLROUTER_RECURRING !== "0";
export function promptKey(prompt) {
    const flat = prompt.toLowerCase().replace(/\d+/g, "#").replace(/\s+/g, " ").trim();
    return createHash("sha256").update(flat).digest("hex").slice(0, 32);
}
export function readRecurring() {
    try {
        const d = JSON.parse(fs.readFileSync(FILE(), "utf8"));
        if (d && typeof d === "object" && d.prompts && typeof d.prompts === "object" && !Array.isArray(d.prompts))
            return { v: 1, prompts: d.prompts };
    }
    catch { /* none yet, or unreadable: start over */ }
    return { v: 1, prompts: {} };
}
function update(fn) {
    try {
        const store = readRecurring();
        fn(store);
        const keys = Object.keys(store.prompts);
        if (keys.length > MAX_PROMPTS)
            for (const k of keys.sort((a, b) => String(store.prompts[a].last).localeCompare(String(store.prompts[b].last))).slice(0, keys.length - MAX_PROMPTS))
                delete store.prompts[k];
        fs.mkdirSync(SR_DIR, { recursive: true });
        const tmp = `${FILE()}.tmp-${process.pid}`;
        fs.writeFileSync(tmp, JSON.stringify(store));
        renameSyncRetry(tmp, FILE());
    }
    catch { /* memory is a convenience: never fail a hook over it */ }
}
/**
 * A request has come in: remember that this session's turn is answering it, and return the skills earlier runs of
 * the same request loaded (most used first, two at most).
 */
export function recallRequest(session, turn, prompt) {
    const key = promptKey(prompt);
    if (!recurringEnabled())
        return { key, skills: [], runs: 0 };
    const entry = entryOf(readRecurring().prompts[key]);
    const skills = Object.entries(entry.skills).filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 2).map(([id]) => id);
    setPromptKey(session, turn, key);
    // One count per session: a hook run twice for one prompt, or the same prompt repeated in a conversation, is one run.
    if (session && claim(session, `recur-run-${key}`))
        update((s) => { const e = entryOf(s.prompts[key]); e.n++; e.last = new Date().toISOString(); s.prompts[key] = e; });
    return { key, skills, runs: entry.n };
}
/** A skill was loaded in this session: credit it to the request the session is answering (once per session and skill). */
export function creditRequest(session, skill) {
    if (!recurringEnabled() || !session)
        return;
    const key = promptKeyOf(session);
    const id = bareSkill(skill);
    if (!key || !id || !/^[\w.-]{1,120}$/.test(id) || !claim(session, `recur-${key}-${id}`))
        return;
    update((s) => { const e = entryOf(s.prompts[key]); e.skills[id] = (e.skills[id] ?? 0) + 1; e.last = new Date().toISOString(); s.prompts[key] = e; });
}
function entryOf(e) {
    const x = e && typeof e === "object" ? e : {};
    const skills = {};
    if (x.skills && typeof x.skills === "object")
        for (const [k, v] of Object.entries(x.skills))
            if (typeof v === "number" && Number.isFinite(v))
                skills[k] = v;
    return { n: typeof x.n === "number" && Number.isFinite(x.n) ? x.n : 0, last: typeof x.last === "string" ? x.last : "", skills };
}
export function forgetRecurring() { try {
    fs.rmSync(FILE(), { force: true });
}
catch { /* nothing to forget */ } }
export function formatRecurring(store = readRecurring()) {
    const rows = Object.entries(store.prompts).map(([key, e]) => ({ key, ...entryOf(e) })).filter((e) => e.n >= 2).sort((a, b) => b.n - a.n).slice(0, 30);
    if (!rows.length)
        return "No request has been seen twice yet. (Requests are identified by a hash of their text; the text is not stored.)";
    return ["Requests seen more than once (hash of the text; the text is not stored), runs, and the skills loaded while answering them:",
        ...rows.map((e) => `  ${e.key.slice(0, 12)}  ${String(e.n).padStart(4)} runs  last ${e.last.slice(0, 10)}  ${Object.entries(e.skills).sort((a, b) => b[1] - a[1]).map(([id, n]) => `${id} x${n}${n >= 2 ? "" : " (not yet suggested)"}`).join(", ") || "no skill loaded"}`),
        "A skill loaded in two sessions for the same request is named at once the next time. `skillrouter recurring reset` forgets everything."].join("\n");
}
