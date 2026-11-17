import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { SR_DIR } from "./paths.js";
import { bareSkill, claim, promptKeyOf, release, setPromptKey } from "./state.js";
import { findSkill } from "./search.js";
import { renameSyncRetry } from "./platform.js";

/**
 * What a request used last time. A scheduled job sends the same prompt every run; each run had to search again (and,
 * with the gate, was refused until it did) to arrive at the skill it used the run before. Here the prompt check
 * remembers, per request, which skills were loaded while answering it, and names them at once the next time the same
 * request comes in: loading one satisfies the gate, so the search is skipped only when its answer is already known.
 *
 * A request is identified by a hash of its text with case, spacing and numbers flattened (dates and counters change
 * between runs); the text itself is never stored. Skills are remembered once they were loaded in two different
 * sessions for that request, and dropped again once named three runs in a row without being used. Because numbers
 * are flattened, "fix issue 12" and "fix issue 97" are one request: the note says so and leaves the judgment to the
 * agent. SKILLROUTER_RECURRING=0 turns it off; `skillrouter recurring` lists what is remembered.
 */
const FILE = () => path.join(SR_DIR, "recurring.json");
const MAX_PROMPTS = 2000;
export const recurringEnabled = () => process.env.SKILLROUTER_RECURRING !== "0";

/** `offered`: how many runs in a row a skill was named without being loaded; three, and it is no longer named. */
/** `refused`: runs in a row in which the search gate refused this request and no search or load was seen since. */
interface Entry { n: number; last: string; skills: Record<string, number>; offered: Record<string, number>; refused: number }
interface Store { v: 1; prompts: Record<string, Entry> }

export function promptKey(prompt: string): string {
  const flat = prompt.toLowerCase().replace(/\d+/g, "#").replace(/\s+/g, " ").trim();
  return createHash("sha256").update(flat).digest("hex").slice(0, 32);
}

export function readRecurring(): Store {
  try {
    const d = JSON.parse(fs.readFileSync(FILE(), "utf8"));
    if (d && typeof d === "object" && d.prompts && typeof d.prompts === "object" && !Array.isArray(d.prompts)) return { v: 1, prompts: d.prompts };
  } catch { /* none yet, or unreadable: start over */ }
  return { v: 1, prompts: {} };
}

/** Read, change and write back under a short lock, so hooks running at once do not overwrite each other's change. */
function update(fn: (s: Store) => void): boolean {
  const lock = `${FILE()}.lock`;
  let held = false;
  try {
    fs.mkdirSync(SR_DIR, { recursive: true });
    for (let i = 0; i < 40 && !held; i++) {
      try { fs.mkdirSync(lock); held = true; }
      catch {
        try { if (Date.now() - fs.statSync(lock).mtimeMs > 2000) fs.rmdirSync(lock); } catch { /* gone meanwhile */ } // a holder that died
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      }
    }
    if (!held) return false; // busy for 200 ms: the caller gives its claim back, so a later hook makes the change
    const store = readRecurring();
    fn(store);
    const keys = Object.keys(store.prompts);
    if (keys.length > MAX_PROMPTS) for (const k of keys.sort((a, b) => String(store.prompts[a].last).localeCompare(String(store.prompts[b].last))).slice(0, keys.length - MAX_PROMPTS)) delete store.prompts[k];
    const tmp = `${FILE()}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(store), { mode: 0o600 }); // hashes of the user's requests: theirs alone to read
    renameSyncRetry(tmp, FILE());
    return true;
  } catch { return false; } // memory is a convenience: never fail a hook over it
  finally { if (held) try { fs.rmdirSync(lock); } catch { /* already gone */ } }
}

/**
 * A request has come in: remember that this session's turn is answering it, and return the skills earlier runs of
 * the same request loaded (most used first, two at most).
 */
export function recallRequest(session: string | undefined, turn: string | undefined, prompt: string): { key: string; skills: string[]; runs: number } {
  const key = promptKey(prompt);
  if (!recurringEnabled()) return { key, skills: [], runs: 0 };
  const entry = entryOf(readRecurring().prompts[key]);
  const skills = Object.entries(entry.skills).filter(([id, n]) => n >= 2 && (entry.offered[id] ?? 0) < 3).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 2).map(([id]) => id);
  setPromptKey(session, turn, key);
  // One count per session: a hook run twice for one prompt, or the same prompt repeated in a conversation, is one run.
  const run = `recur-run-${key}`;
  if (session && claim(session, run)) {
    const done = update((s) => { const e = entryOf(s.prompts[key]); e.n++; e.last = new Date().toISOString(); for (const id of skills) e.offered[id] = (e.offered[id] ?? 0) + 1; s.prompts[key] = e; });
    if (!done) release(session, run);
  }
  return { key, skills, runs: entry.n };
}

/** The indexed skill a load names, as the bare name remembered for a request; nothing for a name that is not exactly one skill. */
export function knownSkill(name: string): string | undefined {
  try { const found = findSkill(name); return found.length === 1 ? bareSkill(found[0].id) : undefined; } catch { return undefined; }
}

/** A skill was loaded in this session: credit it to the request the session's current turn is answering (once per session and skill). */
export function creditRequest(session: string | undefined, skill: string): void {
  if (!recurringEnabled() || !session) return;
  const key = promptKeyOf(session);
  const id = bareSkill(skill);
  const mark = `recur-${key}-${id}`;
  if (!key || !id || !/^[\w.-]{1,120}$/.test(id) || !claim(session, mark)) return;
  const done = update((s) => { const e = entryOf(s.prompts[key]); e.skills[id] = (e.skills[id] ?? 0) + 1; e.offered[id] = 0; e.last = new Date().toISOString(); s.prompts[key] = e; });
  if (!done) release(session, mark);
}

function entryOf(e: unknown): Entry {
  const x = e && typeof e === "object" ? (e as Partial<Entry>) : {};
  const counts = (v: unknown) => { const out: Record<string, number> = {}; if (v && typeof v === "object") for (const [k, n] of Object.entries(v)) if (typeof n === "number" && Number.isFinite(n)) out[k] = n; return out; };
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);
  return { n: num(x.n), last: typeof x.last === "string" ? x.last : "", skills: counts(x.skills), offered: counts(x.offered), refused: num(x.refused) };
}

/**
 * A request the search gate keeps stopping. Seen on a Mac, 2026-11-11 to 15: an hourly automation ran in a thread
 * without the router's tools, was refused once per run, ended each run there, and skipped its work 88 times; nothing
 * surfaced it for four days. Two runs of the same request refused without any search or load seen in either one, and
 * the gate stops refusing that request (logged as `stepped_aside_recurring`) until a run does search or load again.
 * So a scheduled job loses two runs at most, whatever the agent makes of the refusal.
 */
// Read by the process that answers the hook (the warm service reads its own environment when it starts), like the
// other tunables. Unset or empty: 2.
export const stallRuns = () => { const v = (process.env.SKILLROUTER_GATE_STALL_RUNS ?? "").trim(); const n = v === "" ? 2 : Number(v); return Number.isInteger(n) && n >= 0 ? n : 2; };

/** Before this turn's first refusal: has this request already been refused in enough earlier runs without a search? */
export function stalledRequest(session: string | undefined): boolean {
  if (!recurringEnabled() || !stallRuns()) return false;
  const key = promptKeyOf(session);
  return !!key && entryOf(readRecurring().prompts[key]).refused >= stallRuns();
}

/**
 * Per turn, not per session: a session can carry the same request in two turns, and each is a run. A refusal adds a
 * run; a search or load in any run clears the count, so only refusals in a row with no lookup since add up.
 */
export function noteRefusal(session: string | undefined, turn: string): void { countRun(session, turn, "refused"); }
export function noteLookup(session: string | undefined, turn: string): void { countRun(session, turn, "lookup"); }

function countRun(session: string | undefined, turn: string, kind: "refused" | "lookup"): void {
  if (!recurringEnabled() || !session) return;
  const key = promptKeyOf(session);
  const mark = `recur-${kind}-${key}-${turn}`.slice(0, 160);
  if (!key || !claim(session, mark)) return;
  const done = update((s) => { const e = entryOf(s.prompts[key]); if (kind === "lookup") { if (!e.refused) return; e.refused = 0; } else e.refused++; s.prompts[key] = e; });
  if (!done) release(session, mark);
}

/** Forget the requests whose hash starts with `prefix` (as `skillrouter recurring` prints them). */
export function forgetRequest(prefix: string): number {
  const p = prefix.trim().toLowerCase();
  if (!/^[a-f0-9]{4,32}$/.test(p)) return 0;
  let n = 0;
  update((s) => { for (const k of Object.keys(s.prompts)) if (k.startsWith(p)) { delete s.prompts[k]; n++; } });
  return n;
}

export function forgetRecurring(): void { try { fs.rmSync(FILE(), { force: true }); } catch { /* nothing to forget */ } }

export function formatRecurring(store = readRecurring()): string {
  const rows = Object.entries(store.prompts).map(([key, e]) => ({ key, ...entryOf(e) })).filter((e) => e.n >= 2).sort((a, b) => b.n - a.n).slice(0, 30);
  if (!rows.length) return "No request has been seen twice yet. (Requests are identified by a hash of their text; the text is not stored.)";
  return ["Requests seen more than once (hash of the text; the text is not stored), runs, and the skills loaded while answering them:",
    ...rows.map((e) => `  ${e.key.slice(0, 12)}  ${String(e.n).padStart(4)} runs  last ${e.last.slice(0, 10)}  ${Object.entries(e.skills).sort((a, b) => b[1] - a[1]).map(([id, n]) => `${id} x${n}${n < 2 ? " (not yet suggested)" : (e.offered[id] ?? 0) >= 3 ? " (no longer suggested: named 3 runs in a row without being used)" : ""}`).join(", ") || "no skill loaded"}`),
    "A skill loaded in two sessions for the same request is named at once the next time. `skillrouter recurring forget <hash>` forgets one request, `recurring reset` all of them."].join("\n");
}
