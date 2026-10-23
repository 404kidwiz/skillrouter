import fs from "node:fs";
import path from "node:path";
import { CORE_DIR, CORE_FILE, SR_DIR, AGENT_SKILL_DIRS, AGENTS, type AgentId } from "./paths.js";
import { findSkill, getIndex } from "./search.js";

export interface CoreEntry { id: string; skip: Set<AgentId> }

const HEADER = "# skillrouter core: skills every agent preloads. Everything else is reachable via search_skills/read_skill.\n# Line format: <skill id> [!agent ...]   e.g. `pdf !claude` = preload everywhere except Claude Code (it has pdf via a plugin).\n";

/** core.txt: one skill id per line, optional `!agent` markers for agents that already have the skill, '#' comments. */
export function readCoreEntries(): CoreEntry[] {
  let lines: string[];
  try { lines = fs.readFileSync(CORE_FILE, "utf8").split(/\r?\n/); } catch { return []; }
  const out: CoreEntry[] = [];
  for (const raw of lines) {
    const [id, ...marks] = raw.split("#")[0].trim().split(/\s+/);
    if (!id) continue;
    const skip = new Set(marks.filter((m) => m.startsWith("!")).map((m) => m.slice(1)).filter((a): a is AgentId => (AGENTS as string[]).includes(a)));
    out.push({ id, skip });
  }
  return out;
}

export function readCore(): string[] {
  return readCoreEntries().map((e) => e.id);
}

export function writeCoreEntries(entries: CoreEntry[]): void {
  fs.mkdirSync(SR_DIR, { recursive: true });
  const seen = new Set<string>();
  const lines = entries.filter((e) => !seen.has(e.id) && seen.add(e.id)).map((e) => [e.id, ...[...e.skip].sort().map((a) => `!${a}`)].join(" "));
  fs.writeFileSync(CORE_FILE, HEADER + lines.join("\n") + "\n");
}

export function writeCore(ids: string[]): void {
  const keep = new Map(readCoreEntries().map((e) => [e.id, e]));
  writeCoreEntries(ids.map((id) => keep.get(id) ?? { id, skip: new Set() }));
}

/** Mark (or unmark) agents that must not get this core skill linked, e.g. because a plugin already provides it. */
export function skipCore(id: string, agents: AgentId[], on = true): boolean {
  const entries = readCoreEntries();
  const entry = entries.find((e) => e.id === id);
  if (!entry) return false;
  for (const a of agents) on ? entry.skip.add(a) : entry.skip.delete(a);
  writeCoreEntries(entries);
  return true;
}

const PREV_FILE = path.join(SR_DIR, "core.synced");

/**
 * Rebuild ~/.skillrouter/core as symlinks to the core skills, then link them into the agent folders
 * that need them. A skill removed from core since the last sync has its symlink (never a real
 * folder) removed from those agent folders too, so `core remove` takes effect.
 */
export function syncCore(agents: AgentId[]): { linked: number; missing: string[]; skipped: number; unlinked: number } {
  const entries = readCoreEntries();
  fs.rmSync(CORE_DIR, { recursive: true, force: true });
  fs.mkdirSync(CORE_DIR, { recursive: true });
  const missing: string[] = [];
  let linked = 0, skipped = 0, unlinked = 0;
  let previous: string[] = [];
  try { previous = JSON.parse(fs.readFileSync(PREV_FILE, "utf8")); } catch { /* first sync */ }
  const current = new Set(entries.map((e) => e.id));
  for (const gone of previous.filter((n) => !current.has(n))) {
    for (const agent of agents) {
      const link = path.join(AGENT_SKILL_DIRS[agent][0], gone);
      try { if (fs.lstatSync(link).isSymbolicLink()) { fs.unlinkSync(link); unlinked++; } } catch { /* not there */ }
    }
  }
  const targets = new Map<string, { target: string; skip: Set<AgentId> }>();
  for (const { id, skip } of entries) {
    const m = findSkill(id);
    if (m.length !== 1) { missing.push(id); continue; }
    targets.set(path.basename(m[0].path).replace(/~\d+$/, ""), { target: m[0].path, skip });
  }
  for (const [name, { target }] of targets) { fs.symlinkSync(target, path.join(CORE_DIR, name)); linked++; }
  // Each agent gets core in its first folder. A folder shared by several agents (~/.agents/skills) is linked once,
  // and a skill is left out of it only when every agent reading that folder skips it.
  const byDir = new Map<string, AgentId[]>();
  for (const agent of agents) { const dir = AGENT_SKILL_DIRS[agent][0]; byDir.set(dir, [...(byDir.get(dir) ?? []), agent]); }
  for (const [dir, readers] of byDir) {
    fs.mkdirSync(dir, { recursive: true });
    for (const [name, { target, skip }] of targets) {
      if (readers.every((a) => skip.has(a))) { skipped++; continue; }
      const link = path.join(dir, name);
      if (fs.existsSync(link)) continue; // real folder or existing link: leave it
      try { fs.unlinkSync(link); } catch { /* not a dangling link */ }
      fs.symlinkSync(target, link);
    }
  }
  fs.writeFileSync(PREV_FILE, JSON.stringify([...targets.keys()]));
  return { linked, missing, skipped, unlinked };
}

/** Starting point: the N skills with the most reads in the usage log, or (first run) nothing. */
export function suggestCore(reads: Map<string, number>, n = 30): string[] {
  const { index } = getIndex();
  const known = new Set(index.skills.map((s) => s.id));
  return [...reads.entries()].filter(([id]) => known.has(id)).sort((a, b) => b[1] - a[1]).slice(0, n).map(([id]) => id);
}
