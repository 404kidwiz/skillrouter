import fs from "node:fs";
import path from "node:path";
import { AGENT_SKILL_DIRS, AGENTS, USAGE_LOG } from "./paths.js";
import { health } from "./health.js";
import { parseFrontmatter } from "./index.js";
import { bareSkill } from "./state.js";
import { usageArchives } from "./search.js";
import { funnelLines, gateFunnel } from "./funnel.js";
import { readVerdicts, suppressAfter, suppressedByAgent, endorsed, endorseAfter } from "./verdicts.js";

export interface Row { ts: string; client: string; tool: string; skill?: string; found?: boolean;
  hits?: [string, number, ...unknown[]][]; sem?: string; sem_error?: string; agent?: string; session?: string; hint_id?: string; reason?: string; via?: string; trigger?: string;
  accepted?: string[]; declined?: string[]; prompt?: string }

export function validRow(value: unknown): value is Row {
  if (!value || typeof value !== "object") return false;
  const r = value as Row;
  return typeof r.ts === "string" && Number.isFinite(Date.parse(r.ts)) && typeof r.client === "string" && typeof r.tool === "string" &&
    (r.found === undefined || typeof r.found === "boolean") &&
    [r.skill, r.agent, r.session, r.hint_id, r.reason].every((v) => v === undefined || typeof v === "string") &&
    (r.hits === undefined || (Array.isArray(r.hits) && r.hits.every((h) => Array.isArray(h) && typeof h[0] === "string" && typeof h[1] === "number")));
}

/** Explicit prompt correlation, or a shared host session; never infer from skill identity alone. */
export function followsHint(hint: Row, read: Row): boolean {
  const elapsed = Date.parse(read.ts) - Date.parse(hint.ts);
  // A load is a router read_skill that succeeded, or a skill_load the PostToolUse hook saw (native Skill tool or read_skill).
  const isLoad = (read.tool === "read_skill" && read.found === true) || read.tool === "skill_load";
  // A subagent's load does not answer a check the main thread was shown, and vice versa.
  if ((hint as { sub?: string }).sub !== (read as { sub?: string }).sub) return false;
  if (!isLoad || elapsed < 0 || elapsed > 30 * 60e3 ||
    !hint.hits?.some(([id]) => bareSkill(id) === bareSkill(read.skill ?? ""))) return false;
  if (hint.agent && read.agent && hint.agent !== read.agent) return false;
  if (hint.session && read.session && hint.session !== read.session) return false;
  if (read.hint_id) return !!hint.hint_id && read.hint_id === hint.hint_id;
  return !!hint.session && hint.session === read.session && !!hint.agent && hint.agent === read.agent;
}

/** Traffic from probes, self-tests and regression clients: real wiring, not real use. Keep it out of adoption numbers. */
export function isSynthetic(row: Row): boolean {
  return /(^|[/\-_])(probe|selftest|self-test|regression|smoke)([/\-_]|$)/i.test(row.client);
}

export function readLog(days: number): Row[] {
  const since = Date.now() - days * 86400e3;
  const out: Row[] = [];
  // Rotated logs first (oldest to newest), skipping those that ended before the window.
  for (const file of [...usageArchives(), USAGE_LOG]) {
    try {
      if (file !== USAGE_LOG && fs.statSync(file).mtimeMs < since) continue;
      for (const l of fs.readFileSync(file, "utf8").split("\n")) {
        if (!l) continue;
        let r: unknown; try { r = JSON.parse(l); } catch { continue; }
        if (validRow(r) && Date.parse(r.ts) >= since && Date.parse(r.ts) <= Date.now()) out.push(r);
      }
    } catch { /* missing or unreadable: the others still count */ }
  }
  return out;
}

/**
 * Skill gaps: searches that came back with nothing, grouped when they share most of their words, and reads of names
 * that do not exist. A group that keeps recurring is either a skill worth writing (or adding to the library) or a
 * recurring job whose wording never matches the skill it should use. (2026-11-15: one scheduled Codex check made up
 * about two thirds of a sample of empty searches, and nothing surfaced it.)
 */
export function gapLines(rows: Row[], min = 3): string[] {
  // Words that say nothing about the task; without this list "the" or "for" alone tie unrelated queries together.
  const STOP = new Set("the and for with from into that this those these your our are was were has have had not but can use using via per its".split(" "));
  const words = (q: string) => new Set(q.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !STOP.has(w)));
  interface Group { words: Set<string>; n: number; agents: Set<string>; members: string[]; seen: Map<string, number> }
  const groups: Group[] = [];
  const byWord = new Map<string, number[]>(); // word -> groups whose first query has it, so a query meets only groups it can share words with
  const MAX_GROUPS = 3000; // a log of nothing but distinct queries: groups seen once make way for new ones
  const COMMON = 1500; // a word in this many groups says nothing about which one a query belongs to, and walking them all is the slow part
  const reindex = () => { byWord.clear(); groups.forEach((g, i) => { for (const t of g.words) { const list = byWord.get(t); if (list) list.push(i); else byWord.set(t, [i]); } }); };
  for (const r of rows) {
    const q = (r as { query?: unknown }).query;
    if (r.tool !== "search_skills" || typeof q !== "string" || (r.hits?.length ?? 0) > 0 || (r as { exploratory?: unknown }).exploratory || r.reason) continue;
    const w = words(q);
    if (!w.size) continue;
    const shared = new Map<number, number>();
    for (const t of w) { const list = byWord.get(t); if (list && (list.length <= COMMON || w.size === 1)) for (const g of list) shared.set(g, (shared.get(g) ?? 0) + 1); }
    // Same group: most words of the shorter query are shared, and at least two of them (a one-word query joins only its twin).
    let best = -1, bestShared = 0;
    for (const [g, both] of shared) {
      const small = Math.min(w.size, groups[g].words.size), large = Math.max(w.size, groups[g].words.size);
      const same = both / small >= 0.5 && (both >= Math.min(3, small)) && (both >= 2 || large === 1);
      if (same && both > bestShared) { best = g; bestShared = both; }
    }
    let g: Group;
    if (best >= 0) { g = groups[best]; g.n++; g.agents.add(agentOf(r)); if (g.members.length < 60) g.members.push(q); }
    else {
      if (groups.length >= MAX_GROUPS) { const kept = groups.filter((x) => x.n > 1); groups.length = 0; groups.push(...kept); reindex(); }
      g = { words: w, n: 1, agents: new Set([agentOf(r)]), members: [q], seen: new Map() };
      groups.push(g);
      for (const t of w) { const list = byWord.get(t); if (list) list.push(groups.length - 1); else byWord.set(t, [groups.length - 1]); }
    }
    for (const t of w) g.seen.set(t, (g.seen.get(t) ?? 0) + 1);
  }
  // One recurring job is phrased hundreds of ways and lands in several groups, each opened by a different first
  // phrasing. Two groups whose queries use the same words at the same rates (cosine of their word counts 0.6 or
  // more) are the same job: the smaller is folded into the larger. Jobs that share only boilerplate ("read-only
  // production …") stay apart, at about 0.5. Only groups that recur are compared.
  const coreOf = (g: Group) => [...g.seen.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 5).map(([t]) => t);
  const alike = (a: Group, b: Group) => {
    let dot = 0, na = 0, nb = 0;
    for (const [t, n] of a.seen) { na += n * n; const m = b.seen.get(t); if (m) dot += n * m; }
    for (const n of b.seen.values()) nb += n * n;
    return na && nb ? dot / Math.sqrt(na * nb) : 0;
  };
  const recurring = groups.filter((g) => g.n >= 2).sort((a, b) => b.n - a.n).slice(0, 300);
  const folded = new Set<Group>();
  for (let i = 0; i < recurring.length; i++) {
    const a = recurring[i];
    if (folded.has(a)) continue;
    for (let j = i + 1; j < recurring.length; j++) {
      const b = recurring[j];
      if (folded.has(b) || a.seen.size < 3 || b.seen.size < 3 || alike(a, b) < 0.6) continue;
      a.n += b.n; for (const x of b.agents) a.agents.add(x); for (const m of b.members) if (a.members.length < 60) a.members.push(m);
      for (const [t, n] of b.seen) a.seen.set(t, (a.seen.get(t) ?? 0) + n);
      folded.add(b);
    }
  }
  if (folded.size) { const kept = groups.filter((g) => !folded.has(g)); groups.length = 0; groups.push(...kept); }
  // The line shown for a group: the member that carries most of the words the group's queries have in common, the
  // shortest such one (the shortest member alone can be an outlier that merely shares the boilerplate).
  const sampleOf = (g: Group) => {
    const core = new Set(coreOf(g));
    let pick = g.members[0], score = -1;
    for (const m of g.members) { let n = 0; for (const t of words(m)) if (core.has(t)) n++; if (n > score || (n === score && m.length < pick.length)) { pick = m; score = n; } }
    return pick;
  };
  const out: string[] = [];
  const repeated = groups.filter((g) => g.n >= min).sort((a, b) => b.n - a.n).slice(0, 10);
  if (repeated.length) out.push("", "Skill gaps (repeated searches that found nothing; write or add a skill, or reword the job):",
    ...repeated.map((g) => `  ${String(g.n).padStart(4)}  ${[...g.agents].sort().join("+")}: ${sampleOf(g).slice(0, 110)}`));
  const missing = new Map<string, number>();
  for (const r of rows) if (r.tool === "read_skill" && r.found === false && r.skill && !r.reason) missing.set(r.skill, (missing.get(r.skill) ?? 0) + 1);
  const names = [...missing.entries()].filter(([, n]) => n >= min).sort((a, b) => b[1] - a[1]).slice(0, 10);
  if (names.length) out.push("", "Reads of names that are not in the index (a rule or skill refers to them; fix the reference or reindex):",
    ...names.map(([id, n]) => `  ${String(n).padStart(4)}  ${id}`));
  return out;
}

export function readCounts(days: number): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of readLog(days)) if (r.tool === "read_skill" && r.found && r.skill) m.set(r.skill, (m.get(r.skill) ?? 0) + 1);
  return m;
}

/**
 * Which agent a row came from: the `agent` field (hooks, and MCP servers installed with SKILLROUTER_AGENT),
 * else the MCP client name the host announces (older installs logged only that).
 */
export function agentOf(r: Row): string {
  if (r.agent) return r.agent;
  const c = String(r.client ?? "").toLowerCase();
  const known: [RegExp, string][] = [[/^claude-code|^hook\/claude/, "claude"], [/codex/, "codex"], [/cursor/, "cursor"], [/gemini/, "gemini"], [/opencode/, "opencode"], [/openclaude/, "openclaude"], [/antigravity/, "antigravity"], [/hermes/, "hermes"]];
  return known.find(([re]) => re.test(c))?.[1] ?? (String(r.client ?? "").split("/")[0] || "unknown"); // one row per client, not per version
}

export function report(days = 7, rows = readLog(days)): string {
  const synthetic = rows.filter(isSynthetic);
  const organic = rows.filter((r) => !isSynthetic(r));
  const searches = organic.filter((r) => r.tool === "search_skills");
  const reads = organic.filter((r) => r.tool === "read_skill" && r.found);
  const hints = rows.filter((r) => r.tool === "hint" || (r.tool === "trigger" && r.reason === "shown")); // prompt hints + action triggers
  const loads = organic.filter((r) => r.tool === "skill_load");
  const decisions = rows.filter((r) => r.tool === "decision");
  const native = loads.filter((r) => r.via !== "read_skill"); // read_skill loads are already counted from the MCP server
  const out = [`Last ${days} days: ${searches.length} searches, ${reads.length} successful MCP skill loads, ${native.length} native skill loads (Skill tool, activate_skill, SKILL.md reads), ${hints.length} hook invocations`];
  if (synthetic.length) out.push(`Excluded as synthetic (probe/self-test clients): ${synthetic.filter((r) => r.tool === "search_skills").length} searches, ${synthetic.filter((r) => r.tool === "read_skill" && r.found).length} loads from ${[...new Set(synthetic.map((r) => r.client))].join(", ")}`);
  out.push("", "By agent (searches / MCP reads / native loads):");
  for (const a of [...new Set([...searches, ...reads, ...native].map(agentOf))].sort())
    out.push(`  ${a}: ${searches.filter((r) => agentOf(r) === a).length} / ${reads.filter((r) => agentOf(r) === a).length} / ${native.filter((r) => agentOf(r) === a).length}`);
  out.push("", "Most-read skills (candidates for core):");
  for (const [id, n] of [...[...reads, ...native].reduce((counts, r) => { if (r.skill) { const k = r.skill.replace(/^catalog--/, ""); counts.set(k, (counts.get(k) ?? 0) + 1); } return counts; }, new Map<string, number>()).entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)) out.push(`  ${String(n).padStart(4)}  ${id}`);
  if (hints.length) {
    const shown = hints.filter((h) => h.hits?.length);
    const followed = shown.filter((h) => [...reads, ...loads].some((r) => followsHint(h, r)));
    const syntheticFollowed = shown.filter((h) => !followed.includes(h) && synthetic.some((r) => followsHint(h, r)));
    const uncorrelated = shown.filter((h) => !h.hint_id && !(h.session && h.agent));
    const checks = hints.filter((h) => h.tool === "hint" && (h.reason === "shown" || h.reason === "no_match"));
    const checksShown = checks.filter((h) => h.reason === "shown");
    out.push("", `Hints: ${shown.length}/${hints.length} hook invocations showed hints; ${followed.length}/${shown.length} shown hints have a correlated organic successful load within 30 minutes` +
      (syntheticFollowed.length ? ` (${syntheticFollowed.length} more were followed only by synthetic probe loads)` : "") + ".",
      `Prompt checks: ${checksShown.length}/${checks.length} showed a hint (the rest found nothing confident enough); ${checksShown.reduce((n, h) => n + (h.hits?.length ?? 0), 0)} skills suggested in all.`,
      `Unattributable legacy hints: ${uncorrelated.length}.`);
    const sem = new Map<string, number>();
    for (const h of checks) { const k = typeof h.sem === "string" ? h.sem : "off"; sem.set(k, (sem.get(k) ?? 0) + 1); }
    if (checks.length) out.push(`Semantic layer during those checks: ${[...sem.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(", ")}${(sem.get("error") ?? 0) + (sem.get("timeout") ?? 0) + (sem.get("stale") ?? 0) > checks.length / 2 ? " (mostly BM25 alone: run skillrouter doctor)" : ""}.`);
    const triggers = shown.filter((h) => h.tool === "trigger");
    if (triggers.length) out.push(`Action triggers: ${triggers.length} fired (${[...new Set(triggers.map((t) => t.trigger))].join(", ")}); ${triggers.filter((h) => followed.includes(h)).length} followed by a load.`);
  }
  if (decisions.length) {
    const by = (r: string) => decisions.filter((d) => d.reason === r).length;
    out.push(`Turn endings after hints: ${by("decided")} decided (loaded or wrote \`Skills:\`), ${by("nudged")} nudged, ${by("trivial")} too small to ask, ${by("no_hints")} without hints.`);
  }
  out.push(...funnelLines(gateFunnel(organic, agentOf, Date.now() - days * 86400e3), days));
  {
    // Exploratory searches return weak candidates by request, and a failed search (no index) found nothing for another reason: both are counted apart.
    const flag = (r: Row, k: string) => (r as unknown as Record<string, unknown>)[k];
    const failed = searches.filter((r) => !!r.reason), exploratory = searches.filter((r) => !r.reason && flag(r, "exploratory") === true);
    const plain = searches.filter((r) => !r.reason && flag(r, "exploratory") !== true);
    const empty = plain.filter((r) => !(r.hits?.length)).length, weak = plain.filter((r) => flag(r, "weak") === true && r.hits?.length).length;
    if (plain.length) out.push("", `Searches: ${plain.length}; ${plain.length - empty - weak} with a strong match, ${weak} with weak candidates only, ${empty} with nothing (${Math.round((100 * empty) / plain.length)}%)` +
      `${exploratory.length ? `; plus ${exploratory.length} exploratory` : ""}${failed.length ? `; ${failed.length} failed (index unavailable)` : ""}.`);
  }
  out.push(...gapLines(organic));
  out.push(...verdictLines(rows.filter((r) => r.tool === "verdict")));
  out.push("", "A load is not proof a skill was applied. Native loads (Claude's Skill tool, Gemini's activate_skill, OpenCode's skill tool, SKILL.md reads) " +
    "are seen through each host's tool hook (Claude Code, Codex once its hooks are trusted, Cursor, Gemini CLI, OpenCode); Antigravity, OpenClaude and Hermes count router read_skill loads only.");
  return out.join("\n");
}

/** Per-skill accept rates from decided turns in the period, and what is held back now (all-time counts). */
function verdictLines(verdicts: Row[]): string[] {
  const out: string[] = [];
  const per = new Map<string, { acc: number; dec: number }>();
  const bump = (id: string, k: "acc" | "dec") => { const e = per.get(bareSkill(id)) ?? { acc: 0, dec: 0 }; e[k]++; per.set(bareSkill(id), e); };
  for (const v of verdicts) { (v.accepted ?? []).forEach((id) => bump(id, "acc")); (v.declined ?? []).forEach((id) => bump(id, "dec")); }
  const acc = [...per.values()].reduce((n, e) => n + e.acc, 0), dec = [...per.values()].reduce((n, e) => n + e.dec, 0);
  if (verdicts.length) {
    out.push("", `Skill decisions: ${verdicts.length} decided turns after checks; ${acc} of ${acc + dec} suggested skills accepted (${Math.round((100 * acc) / Math.max(1, acc + dec))}%).`);
    const rate = ([id, e]: [string, { acc: number; dec: number }]) => `  ${`${e.acc}/${e.acc + e.dec}`.padStart(6)}  ${id}`;
    const taken = [...per].filter(([, e]) => e.acc).sort((a, b) => b[1].acc - a[1].acc || a[1].dec - b[1].dec).slice(0, 8);
    const turnedDown = [...per].filter(([, e]) => e.dec).sort((a, b) => b[1].dec - a[1].dec || a[1].acc - b[1].acc).slice(0, 8);
    if (taken.length) out.push("Most accepted (accepted/suggested):", ...taken.map(rate));
    if (turnedDown.length) out.push("Most declined (accepted/suggested):", ...turnedDown.map(rate));
  }
  const v = readVerdicts();
  for (const [agent, held] of suppressedByAgent(v)) {
    const ids = [...held];
    out.push(`Held back from ${agent}'s checks (declined in ${suppressAfter()}+ sessions, accepted under 10%; search_skills still finds them): ` +
      ids.slice(0, 12).map((id) => `${id} (${v.agents[agent][id].accepted}/${v.agents[agent][id].shown})`).join(", ") + (ids.length > 12 ? ` and ${ids.length - 12} more` : "") +
      ". Exempt one: skillrouter suppress keep <id>.");
  }
  for (const agent of Object.keys(v.agents).sort()) {
    const ids = [...endorsed(agent, v)];
    if (ids.length) out.push(`Endorsed on ${agent} (accepted in ${endorseAfter()}+ turns and at least half the time; shown on a lower bar): ` +
      ids.slice(0, 12).map((id) => `${id} (${v.agents[agent][id].accepted}/${v.agents[agent][id].shown})`).join(", ") + (ids.length > 12 ? ` and ${ids.length - 12} more` : "") + ".");
  }
  return out;
}

/** What each agent loads at startup right now, and roughly what it costs. */
export function doctor(): string {
  const out: string[] = [];
  const byDir = new Map<string, string[]>();
  for (const agent of AGENTS) for (const dir of AGENT_SKILL_DIRS[agent]) byDir.set(dir, [...(byDir.get(dir) ?? []), agent]);
  for (const [dir, agents] of byDir) {
    if (!fs.existsSync(dir)) continue;
    {
      let n = 0, chars = 0, broken = 0;
      for (const e of fs.readdirSync(dir)) {
        if (e.startsWith(".")) continue;
        const p = path.join(dir, e);
        try {
          const text = fs.readFileSync(path.join(p, "SKILL.md"), "utf8").slice(0, 4000);
          const fm = parseFrontmatter(text);
          n++; chars += e.length + (fm.description ?? "").length + 12;
        } catch { if (!fs.existsSync(p)) broken++; }
      }
      const real = fs.lstatSync(dir).isSymbolicLink() ? ` -> ${fs.readlinkSync(dir)}` : "";
      out.push(`${agents.join("+").padEnd(9)} ${dir}${real}: ${n} skills (~${Math.round(chars / 4)} tokens of names+descriptions per prompt)${broken ? `, ${broken} broken links` : ""}`);
    }
  }
  out.push(...health());
  return out.join("\n");
}
