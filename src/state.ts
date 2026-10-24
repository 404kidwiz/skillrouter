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

const dirOf = (session: string) => path.join(STATE_DIR, session.replace(/[^a-f0-9]/gi, "").slice(0, 64) || "unknown");

function writableDir(session: string): string {
  const dir = dirOf(session);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    prune(dir);
  }
  return dir;
}

function touch(dir: string): void { try { const now = new Date(); fs.utimesSync(dir, now, now); } catch { /* best effort */ } }

function prune(keep: string): void {
  try {
    for (const e of fs.readdirSync(STATE_DIR)) {
      const p = path.join(STATE_DIR, e);
      if (p !== keep && Date.now() - fs.statSync(p).mtimeMs > KEEP_MS) fs.rmSync(p, { recursive: true, force: true });
    }
  } catch { /* best effort */ }
}

/** True exactly once per (session, key), across concurrent processes. Without a session id nothing can be deduped: false. */
export function claim(session: string | undefined, key: string): boolean {
  if (!session) return false;
  try {
    const dir = writableDir(session);
    fs.closeSync(fs.openSync(path.join(dir, `claim-${key.replace(/[^\w.-]/g, "_")}`), "wx"));
    touch(dir);
    return true;
  } catch { return false; }
}

/** Whether a claim exists, without taking it. */
export function claimed(session: string | undefined, key: string): boolean {
  return !!session && fs.existsSync(path.join(dirOf(session), `claim-${key.replace(/[^\w.-]/g, "_")}`));
}

/** Give a claim back, so a later call can take it again. */
export function release(session: string | undefined, key: string): void {
  if (session) try { fs.unlinkSync(path.join(dirOf(session), `claim-${key.replace(/[^\w.-]/g, "_")}`)); } catch { /* not held */ }
}

function append(session: string | undefined, file: string, row: object): void {
  if (!session) return;
  try { const dir = writableDir(session); fs.appendFileSync(path.join(dir, file), JSON.stringify({ ts: Date.now(), ...row }) + "\n"); touch(dir); } catch { /* best effort */ }
}

function rows(session: string | undefined, file: string): any[] {
  if (!session) return [];
  try {
    return fs.readFileSync(path.join(dirOf(session), file), "utf8").split("\n").filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

export function addLoaded(session: string | undefined, skill: string, sub?: string): void { append(session, "loaded.jsonl", { skill, sub }); }

/** Skills loaded in this session (by this agent: main thread when `sub` is undefined), optionally within a time window. */
export function loadedSkills(session: string | undefined, sub?: string, since = 0, until = Infinity): Set<string> {
  return new Set(rows(session, "loaded.jsonl").filter((r) => r.sub === sub && r.ts >= since && r.ts < until).map((r) => bareSkill(String(r.skill))));
}

/**
 * A check that was shown on the main thread, keyed by the hashed prompt_id when the host sends one. `alts`:
 * for a shown skill, the siblings it named as "similar". They are not repeated later, and taking one counts
 * as taking the suggestion; only `ids` were suggested (verdicts, nudges).
 */
export function addShown(session: string | undefined, ids: string[], prompt?: string, alts: Record<string, string[]> = {}): void {
  append(session, "shown.jsonl", { ids, prompt, ...(Object.keys(alts).length ? { alts } : {}) });
}

function shownRows(session: string | undefined, prompt: string | undefined, since: number): any[] {
  const all = rows(session, "shown.jsonl");
  return prompt && all.some((r) => r.prompt) ? all.filter((r) => r.prompt === prompt) : all.filter((r) => r.ts >= since);
}

const list = (v: unknown) => (Array.isArray(v) ? v.map(String) : []);

/** Skill ids shown for this prompt (exact), or, for hosts without prompt ids, since a time; `withAlts` adds named siblings. */
export function shownFor(session: string | undefined, prompt: string | undefined, since: number, withAlts = false): string[] {
  return [...new Set(shownRows(session, prompt, since).flatMap((r) => [...list(r.ids), ...(withAlts ? Object.values(r.alts ?? {}).flatMap(list) : [])]))];
}

/** For each skill shown for this prompt, the siblings named with it. */
export function shownAlts(session: string | undefined, prompt: string | undefined, since: number): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const r of shownRows(session, prompt, since)) for (const [id, alts] of Object.entries(r.alts ?? {})) out.set(id, [...(out.get(id) ?? []), ...list(alts)]);
  return out;
}

/**
 * Turn bookkeeping for hosts whose transcripts skillrouter does not read (Codex, Cursor, Gemini CLI):
 * the prompt hook marks where a turn starts, the tool hook counts the work done in it, and the
 * end-of-turn hook reads both. `turn` is the hashed host turn id when the host has one.
 */
export function markTurn(session: string | undefined, turn?: string): void { append(session, "turns.jsonl", { turn }); }

export function addTool(session: string | undefined, turn?: string, sub?: string): void { append(session, "tools.jsonl", { turn, sub }); }

/**
 * True the first time a tool call (its host-given id) is seen in this session, and records it. A hook run again after
 * the warm service timed out then doesn't count the same call twice. Hosts that send no id always count.
 */
export function firstUse(session: string | undefined, useId: unknown): boolean {
  if (!session || typeof useId !== "string" || !useId) return true;
  const id = useId.slice(0, 80);
  try {
    const dir = writableDir(session);
    const file = path.join(dir, "uses.jsonl");
    let seen = false;
    try {
      const size = fs.statSync(file).size;
      const fd = fs.openSync(file, "r");
      try { const buf = Buffer.alloc(Math.min(size, 16384)); fs.readSync(fd, buf, 0, buf.length, size - buf.length); seen = buf.toString("utf8").includes(JSON.stringify(id)); } finally { fs.closeSync(fd); }
    } catch { /* no file yet */ }
    if (seen) return false;
    fs.appendFileSync(file, JSON.stringify(id) + "\n");
    touch(dir);
  } catch { /* best effort: count it */ }
  return true;
}

/** A turn's time span: from its marker to the next marker (open-ended for the current turn). */
export function turnWindow(session: string | undefined, turn: string): { start?: number; end: number } {
  const marks = rows(session, "turns.jsonl");
  const i = marks.map((r) => r.turn).lastIndexOf(turn);
  if (i < 0) return { end: Infinity };
  return { start: marks[i].ts, end: marks.slice(i + 1).find((r) => r.ts > marks[i].ts)?.ts ?? Infinity };
}

/** When this turn started (its marker, else the latest one) and how many main-thread tool calls it made. */
export function turnStats(session: string | undefined, turn?: string): { start?: number; tools: number } {
  const marks = rows(session, "turns.jsonl");
  const mark = (turn && marks.filter((r) => r.turn === turn).pop()) || marks.pop();
  if (!mark) return { tools: 0 };
  const tools = rows(session, "tools.jsonl").filter((r) => !r.sub && r.ts >= mark.ts && (!turn || !r.turn || r.turn === turn)).length;
  return { start: mark.ts, tools };
}

/**
 * A nudged turn's checks, so the turn that answers the nudge is credited to them: Codex, Cursor and Gemini
 * continue under a new turn id (or none). `key` is the nudged turn's verdict key.
 */
export function addNudge(session: string | undefined, ids: string[], key: string, since: number, prompt?: string): void { append(session, "nudges.jsonl", { ids, key, since, prompt }); }

/** The latest nudge not yet answered (within 30 minutes). `prompt` is the nudged turn's prompt key, for its siblings. */
export function lastNudge(session: string | undefined, maxAgeMs = 30 * 60e3): { ids: string[]; key: string; since: number; prompt?: string } | undefined {
  const all = rows(session, "nudges.jsonl");
  const done = new Set(all.filter((r) => typeof r.done === "string").map((r) => r.done));
  const r = all.filter((x) => typeof x.key === "string" && Array.isArray(x.ids) && !done.has(x.key)).pop();
  return r && Date.now() - r.ts <= maxAgeMs ? { ids: r.ids.map(String), key: r.key, since: Number(r.since) || r.ts, prompt: r.prompt } : undefined;
}

/** A nudge was answered: it is never credited again. */
export function consumeNudge(session: string | undefined, key: string): void { append(session, "nudges.jsonl", { done: key }); }

/** "plugin:name" and "name~2" are the same skill for matching purposes. */
export const bareSkill = (s: string) => s.split(":").pop()!.replace(/~\d+$/, "").toLowerCase();
