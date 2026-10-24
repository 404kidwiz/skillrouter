import fs from "node:fs";
import path from "node:path";
import { SR_DIR } from "./paths.js";
import { bareSkill } from "./state.js";
import { renameSyncRetry } from "./platform.js";
/**
 * What agents did with the skills skillrouter suggested, per host and skill (bare name): accepted (named on the
 * final `Skills:` line, or loaded) and declined, at most one decline per session. On a host, a skill declined in
 * 5+ sessions and accepted in under 10% of its counted turns is held back from that host's prompt checks and
 * triggers for 30 days after its last verdict, then offered again with a clean slate. search_skills always
 * finds it, an agent loading it on its own counts as accepting it, and `skillrouter suppress keep <id>`
 * exempts it everywhere.
 */
const FILE = path.join(SR_DIR, "verdicts.json");
const LOCK = FILE + ".lock";
const HOLD_MS = 30 * 86400e3;
const ENDORSE_MS = 90 * 86400e3;
// Null-prototype tables: a skill named "constructor" or "__proto__" is just a key.
const table = () => Object.create(null);
const valid = (e) => !!e && typeof e === "object" &&
    ["shown", "accepted", "declined"].every((k) => Number.isFinite(e[k]) && e[k] >= 0) && typeof e.last === "string";
function parse(text) {
    const d = JSON.parse(text);
    if (!d || typeof d !== "object" || Array.isArray(d))
        throw new Error("not a verdicts object");
    const agents = table();
    for (const [agent, skills] of Object.entries(d.agents && typeof d.agents === "object" ? d.agents : {})) {
        const t = table();
        for (const [id, e] of Object.entries(skills && typeof skills === "object" ? skills : {}))
            if (valid(e))
                t[id] = { ...e };
        agents[agent] = t;
    }
    return { agents, keep: Array.isArray(d.keep) ? d.keep.filter((x) => typeof x === "string") : [] };
}
const empty = () => ({ agents: table(), keep: [] });
/** Read for decisions: anything unreadable counts as no verdicts (hooks must never fail on it). */
export function readVerdicts(file = FILE) {
    try {
        return parse(fs.readFileSync(file, "utf8"));
    }
    catch {
        return empty();
    }
}
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
/**
 * Read-modify-write under an O_EXCL lock file (a lock older than 5 s is a crashed writer's and is broken).
 * A file that exists but doesn't parse is moved aside (verdicts.json.bad-<time>), never silently replaced.
 * Gives up after about half a second and returns undefined: a lost count is better than a stalled hook.
 */
function update(fn) {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    for (let i = 0; i < 50; i++) {
        try {
            fs.closeSync(fs.openSync(LOCK, "wx"));
        }
        catch {
            try {
                if (Date.now() - fs.statSync(LOCK).mtimeMs > 5000)
                    fs.rmSync(LOCK, { force: true });
            }
            catch { /* gone already */ }
            pause(10);
            continue;
        }
        try {
            let v = empty();
            if (fs.existsSync(FILE)) {
                try {
                    v = parse(fs.readFileSync(FILE, "utf8"));
                }
                catch {
                    renameSyncRetry(FILE, `${FILE}.bad-${Date.now()}`);
                }
            }
            const out = fn(v);
            const tmp = `${FILE}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
            fs.writeFileSync(tmp, JSON.stringify(v));
            renameSyncRetry(tmp, FILE);
            return out;
        }
        finally {
            fs.rmSync(LOCK, { force: true });
        }
    }
    return undefined;
}
const held = (e, after) => e.declined >= after && e.accepted * 10 < e.shown;
/**
 * Count one decided turn on a host. Callers pass declines already limited to one per session and skill.
 * A skill whose hold has lapsed starts again from zero, so one more decline doesn't bring the hold straight back.
 */
export function addVerdict(agent, accepted, declined) {
    try {
        update((v) => {
            const now = new Date().toISOString();
            const t = (v.agents[agent] ??= table());
            const after = suppressAfter();
            const bump = (id, field) => {
                let e = t[id];
                if (!e || (after > 0 && held(e, after) && Date.now() - Date.parse(e.last) >= HOLD_MS))
                    e = t[id] = { shown: 0, accepted: 0, declined: 0, last: now };
                e.shown++;
                e[field]++;
                e.last = now;
            };
            for (const id of new Set(accepted.map(bareSkill)))
                bump(id, "accepted");
            for (const id of new Set(declined.map(bareSkill)))
                bump(id, "declined");
        });
    }
    catch { /* stats never block a hook */ }
}
/** Declines before a skill is held back (env SKILLROUTER_SUPPRESS_AFTER; 0 turns suppression off, empty means default). */
export function suppressAfter() {
    const raw = process.env.SKILLROUTER_SUPPRESS_AFTER;
    const n = raw === undefined || raw.trim() === "" ? 5 : Number(raw);
    return Number.isFinite(n) ? n : 5;
}
/** Accepted turns before a skill is endorsed on a host (env SKILLROUTER_ENDORSE_AFTER; 0 turns it off, empty means default). */
export function endorseAfter() {
    const raw = process.env.SKILLROUTER_ENDORSE_AFTER;
    const n = raw === undefined || raw.trim() === "" ? 3 : Number(raw);
    return Number.isFinite(n) ? n : 3;
}
/**
 * The mirror of suppression: skills this host has accepted in `endorseAfter()`+ turns and at least half the times
 * they were suggested, with a verdict in the last 90 days. The prompt check lets them through on a lower bar (see
 * selectHints): a weak match for a skill the agent keeps using is worth showing; the same match for an unknown one is not.
 */
export function endorsed(agent, v) {
    try {
        const after = endorseAfter();
        if (!(after > 0))
            return new Set();
        const data = v ?? readVerdicts();
        return new Set(Object.entries(data.agents[agent] ?? {})
            .filter(([, e]) => e.accepted >= after && e.accepted * 2 >= e.shown && Date.now() - Date.parse(e.last) < ENDORSE_MS)
            .map(([id]) => id));
    }
    catch {
        return new Set();
    }
}
/** Held back on this host now: declined in `suppressAfter()`+ sessions, accepted under 10%, last verdict within 30 days, not kept. */
export function suppressed(agent, v) {
    try {
        const after = suppressAfter();
        if (!(after > 0))
            return new Set();
        const data = v ?? readVerdicts();
        const keep = new Set(data.keep.map(bareSkill));
        return new Set(Object.entries(data.agents[agent] ?? {})
            .filter(([id, e]) => !keep.has(id) && held(e, after) && Date.now() - Date.parse(e.last) < HOLD_MS)
            .map(([id]) => id));
    }
    catch {
        return new Set();
    }
}
/** Every host's held-back skills, for report and the CLI. */
export function suppressedByAgent(v = readVerdicts()) {
    return new Map(Object.keys(v.agents).sort().map((a) => [a, suppressed(a, v)]).filter(([, s]) => s.size));
}
/** Exempt skills from suppression on every host (keep) or let them be suppressed again (unkeep). Undefined if busy. */
export function setKeep(ids, keep) {
    return update((v) => {
        const set = new Set(v.keep.map(bareSkill));
        for (const id of ids.map(bareSkill))
            keep ? set.add(id) : set.delete(id);
        v.keep = [...set].sort();
        return v.keep;
    });
}
/** Forget the counts for some skills (or all) on every host. Kept skills stay kept. Undefined if busy. */
export function resetVerdicts(ids = []) {
    return update((v) => {
        let n = 0;
        const targets = new Set(ids.map(bareSkill));
        for (const t of Object.values(v.agents))
            for (const id of Object.keys(t))
                if (!ids.length || targets.has(id)) {
                    delete t[id];
                    n++;
                }
        return n;
    });
}
