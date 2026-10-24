import fs from "node:fs";
import path from "node:path";
import { AGENT_SKILL_DIRS, AGENTS, USAGE_LOG } from "./paths.js";
import { health } from "./health.js";
import { parseFrontmatter } from "./index.js";
import { bareSkill } from "./state.js";
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
  try {
    return fs.readFileSync(USAGE_LOG, "utf8").split("\n").filter(Boolean)
      .map((l) => { try { return JSON.parse(l) as Row; } catch { return null; } })
      .filter((r): r is Row => validRow(r) && Date.parse(r.ts) >= since && Date.parse(r.ts) <= Date.now());
  } catch { return []; }
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
  for (const [id, n] of [...[...reads, ...native].reduce((counts, r) => { if (r.skill) counts.set(r.skill, (counts.get(r.skill) ?? 0) + 1); return counts; }, new Map<string, number>()).entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)) out.push(`  ${String(n).padStart(4)}  ${id}`);
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
