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
/** Skills loaded in this session (by this agent: main thread when `sub` is undefined), optionally since a time. */
export function loadedSkills(session, sub, since = 0) {
    return new Set(rows(session, "loaded.jsonl").filter((r) => r.sub === sub && r.ts >= since).map((r) => bareSkill(String(r.skill))));
}
/** A check that was shown on the main thread, keyed by the hashed prompt_id when the host sends one. */
export function addShown(session, ids, prompt) { append(session, "shown.jsonl", { ids, prompt }); }
/** Skill ids shown for this prompt (exact), or, for hosts without prompt ids, since a time. */
export function shownFor(session, prompt, since) {
    const all = rows(session, "shown.jsonl");
    const mine = prompt && all.some((r) => r.prompt) ? all.filter((r) => r.prompt === prompt) : all.filter((r) => r.ts >= since);
    return [...new Set(mine.flatMap((r) => (Array.isArray(r.ids) ? r.ids.map(String) : [])))];
}
/** "plugin:name" and "name~2" are the same skill for matching purposes. */
export const bareSkill = (s) => s.split(":").pop().replace(/~\d+$/, "").toLowerCase();
