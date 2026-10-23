import fs from "node:fs";
import path from "node:path";
import { AGENT_SKILL_DIRS, AGENTS, USAGE_LOG } from "./paths.js";
import { parseFrontmatter } from "./index.js";

interface Row { ts: string; client: string; tool: string; skill?: string; found?: boolean; hits?: [string, number][] }

export function readLog(days: number): Row[] {
  const since = Date.now() - days * 86400e3;
  try {
    return fs.readFileSync(USAGE_LOG, "utf8").split("\n").filter(Boolean)
      .map((l) => { try { return JSON.parse(l) as Row; } catch { return null; } })
      .filter((r): r is Row => !!r && Date.parse(r.ts) >= since);
  } catch { return []; }
}

export function readCounts(days: number): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of readLog(days)) if (r.tool === "read_skill" && r.found && r.skill) m.set(r.skill, (m.get(r.skill) ?? 0) + 1);
  return m;
}

export function report(days = 7): string {
  const rows = readLog(days);
  const searches = rows.filter((r) => r.tool === "search_skills");
  const reads = rows.filter((r) => r.tool === "read_skill" && r.found);
  const hints = rows.filter((r) => r.tool === "hint");
  const out = [`Last ${days} days: ${searches.length} searches, ${reads.length} skill reads, ${hints.length} prompts checked for hints`, "", "By agent (searches / reads):"];
  for (const c of [...new Set([...searches, ...reads].map((r) => r.client))].sort())
    out.push(`  ${c}: ${searches.filter((r) => r.client === c).length} / ${reads.filter((r) => r.client === c).length}`);
  out.push("", "Most-read skills (candidates for core):");
  for (const [id, n] of [...readCounts(days).entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)) out.push(`  ${String(n).padStart(4)}  ${id}`);
  if (hints.length) {
    const shown = hints.filter((h) => h.hits?.length);
    const hinted = new Set(shown.flatMap((h) => h.hits!.map((x) => x[0])));
    const followed = [...hinted].filter((id) => reads.some((r) => r.skill === id));
    out.push("", `Hints: ${shown.length}/${hints.length} prompts got hints; ${followed.length} of ${hinted.size} hinted skills were later read`);
  }
  return out.join("\n");
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
  out.push("", "Claude Code caps this list at ~1% of the context window and silently drops descriptions past that; other agents send all of it.");
  return out.join("\n");
}
