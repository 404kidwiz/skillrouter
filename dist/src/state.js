import fs from "node:fs";
import path from "node:path";
import { SR_DIR } from "./paths.js";
/**
 * Per-session hook state under ~/.skillrouter/state/<session hash>/: which trigger rules fired (one
 * file each, created with O_EXCL so parallel hooks can't both fire a rule), which skills were loaded,
 * and which checks were shown. Independent of how large the shared usage log grows. A session dir is
 * touched on every write, and dirs untouched for 7 days are pruned when a new session starts.
 */
const STATE_DIR = path.join(SR_DIR, "state");
const KEEP_MS = 7 * 86400e3;
const dirOf = (session) => path.join(STATE_DIR, session.replace(/[^a-f0-9]/gi, "").slice(0, 64) || "unknown");
function writableDir(session) {
    const dir = dirOf(session);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        prune(dir);
    }
    return dir;
}
function touch(dir) { try {
    const now = new Date();
    fs.utimesSync(dir, now, now);
}
catch { /* best effort */ } }
function prune(keep) {
    try {
        for (const e of fs.readdirSync(STATE_DIR)) {
            const p = path.join(STATE_DIR, e);
            if (p !== keep && Date.now() - fs.statSync(p).mtimeMs > KEEP_MS)
                fs.rmSync(p, { recursive: true, force: true });
        }
    }
    catch { /* best effort */ }
}
/** True exactly once per (session, key), across concurrent processes. Without a session id nothing can be deduped: false. */
export function claim(session, key) {
    if (!session)
        return false;
    try {
        const dir = writableDir(session);
        fs.closeSync(fs.openSync(path.join(dir, `claim-${key.replace(/[^\w.-]/g, "_")}`), "wx"));
        touch(dir);
        return true;
    }
    catch {
        return false;
    }
}
/** Whether a claim exists, without taking it. */
export function claimed(session, key) {
    return !!session && fs.existsSync(path.join(dirOf(session), `claim-${key.replace(/[^\w.-]/g, "_")}`));
}
/** Give a claim back, so a later call can take it again. */
export function release(session, key) {
    if (session)
        try {
            fs.unlinkSync(path.join(dirOf(session), `claim-${key.replace(/[^\w.-]/g, "_")}`));
        }
        catch { /* not held */ }
}
function append(session, file, row) {
    if (!session)
        return;
    try {
        const dir = writableDir(session);
        fs.appendFileSync(path.join(dir, file), JSON.stringify({ ts: Date.now(), ...row }) + "\n");
        touch(dir);
    }
    catch { /* best effort */ }
}
function rows(session, file) {
    if (!session)
        return [];
    try {
        return fs.readFileSync(path.join(dirOf(session), file), "utf8").split("\n").filter(Boolean)
            .map((l) => { try {
            return JSON.parse(l);
        }
        catch {
            return null;
        } }).filter(Boolean);
    }
    catch {
        return [];
    }
}
export function addLoaded(session, skill, sub) { append(session, "loaded.jsonl", { skill, sub }); }
/** Skills loaded in this session (by this agent: main thread when `sub` is undefined), optionally within a time window. */
export function loadedSkills(session, sub, since = 0, until = Infinity) {
    return new Set(rows(session, "loaded.jsonl").filter((r) => r.sub === sub && r.ts >= since && r.ts < until).map((r) => bareSkill(String(r.skill))));
}
/**
 * A check that was shown on the main thread, keyed by the hashed prompt_id when the host sends one. `alts`:
 * for a shown skill, the siblings it named as "similar". They are not repeated later, and taking one counts
 * as taking the suggestion; only `ids` were suggested (verdicts, nudges).
 */
export function addShown(session, ids, prompt, alts = {}) {
    append(session, "shown.jsonl", { ids, prompt, ...(Object.keys(alts).length ? { alts } : {}) });
}
function shownRows(session, prompt, since) {
    const all = rows(session, "shown.jsonl");
    return prompt && all.some((r) => r.prompt) ? all.filter((r) => r.prompt === prompt) : all.filter((r) => r.ts >= since);
}
const list = (v) => (Array.isArray(v) ? v.map(String) : []);
/** Skill ids shown for this prompt (exact), or, for hosts without prompt ids, since a time; `withAlts` adds named siblings. */
export function shownFor(session, prompt, since, withAlts = false) {
    return [...new Set(shownRows(session, prompt, since).flatMap((r) => [...list(r.ids), ...(withAlts ? Object.values(r.alts ?? {}).flatMap(list) : [])]))];
}
/** For each skill shown for this prompt, the siblings named with it. */
export function shownAlts(session, prompt, since) {
    const out = new Map();
    for (const r of shownRows(session, prompt, since))
        for (const [id, alts] of Object.entries(r.alts ?? {}))
            out.set(id, [...(out.get(id) ?? []), ...list(alts)]);
    return out;
}
/**
 * Turn bookkeeping for hosts whose transcripts skillrouter does not read (Codex, Cursor, Gemini CLI):
 * the prompt hook marks where a turn starts, the tool hook counts the work done in it, and the
 * end-of-turn hook reads both. `turn` is the hashed host turn id when the host has one.
 */
export function markTurn(session, turn) { append(session, "turns.jsonl", { turn }); }
export function addTool(session, turn, sub) { append(session, "tools.jsonl", { turn, sub }); }
/** A turn's time span: from its marker to the next marker (open-ended for the current turn). */
export function turnWindow(session, turn) {
    const marks = rows(session, "turns.jsonl");
    const i = marks.map((r) => r.turn).lastIndexOf(turn);
    if (i < 0)
        return { end: Infinity };
    return { start: marks[i].ts, end: marks.slice(i + 1).find((r) => r.ts > marks[i].ts)?.ts ?? Infinity };
}
/** When this turn started (its marker, else the latest one) and how many main-thread tool calls it made. */
export function turnStats(session, turn) {
    const marks = rows(session, "turns.jsonl");
    const mark = (turn && marks.filter((r) => r.turn === turn).pop()) || marks.pop();
    if (!mark)
        return { tools: 0 };
    const tools = rows(session, "tools.jsonl").filter((r) => !r.sub && r.ts >= mark.ts && (!turn || !r.turn || r.turn === turn)).length;
    return { start: mark.ts, tools };
}
/**
 * A nudged turn's checks, so the turn that answers the nudge is credited to them: Codex, Cursor and Gemini
 * continue under a new turn id (or none). `key` is the nudged turn's verdict key.
 */
export function addNudge(session, ids, key, since, prompt) { append(session, "nudges.jsonl", { ids, key, since, prompt }); }
/** The latest nudge not yet answered (within 30 minutes). `prompt` is the nudged turn's prompt key, for its siblings. */
export function lastNudge(session, maxAgeMs = 30 * 60e3) {
    const all = rows(session, "nudges.jsonl");
    const done = new Set(all.filter((r) => typeof r.done === "string").map((r) => r.done));
    const r = all.filter((x) => typeof x.key === "string" && Array.isArray(x.ids) && !done.has(x.key)).pop();
    return r && Date.now() - r.ts <= maxAgeMs ? { ids: r.ids.map(String), key: r.key, since: Number(r.since) || r.ts, prompt: r.prompt } : undefined;
}
/** A nudge was answered: it is never credited again. */
export function consumeNudge(session, key) { append(session, "nudges.jsonl", { done: key }); }
/** "plugin:name" and "name~2" are the same skill for matching purposes. */
export const bareSkill = (s) => s.split(":").pop().replace(/~\d+$/, "").toLowerCase();
