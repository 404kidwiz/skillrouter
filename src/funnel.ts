import { sessionLogs } from "./state.js";

/** The usage-log fields the funnel reads (a Row from report.ts, without importing it). */
export interface FunnelUsageRow { ts: string; client: string; tool: string; agent?: string; session?: string; reason?: string; found?: boolean }

export interface FunnelLine {
  agent: string;
  /** Prompts the check marked as a task (the gate applies to their first work call). */
  taskTurns: number;
  /** Task turns that made a work call, or were refused for trying to. */
  worked: number;
  /** Of those, the turns with no search and no skill load. */
  workedNoSearch: number;
  refusals: number;
  refusedTurns: number;
  /** Refused turns in which a search or a load followed the first refusal. */
  searchedAfter: number;
  /** Turns with a search. */
  searched: number;
  /** Of those, the turns in which a skill was loaded at or after the search. */
  loadedAfter: number;
  steppedAside: number;
  /** Turns whose search was found in the router's MCP log, not in the session's own records. */
  borrowed: number;
}

/**
 * How the search gate works out in practice, per agent, over the sessions still on disk (state is kept 7 days). A turn is the
 * span from one prompt's marker to the next. Searches and loads come from the session's own logs (the gate hook records
 * searches itself; the post-tool hook records loads). Where a turn has none of its own, as with Codex before its hook was
 * trusted, the router's MCP log fills in by agent and time, which can borrow a search from another session of the same agent.
 */
export function gateFunnel(rows: FunnelUsageRow[], agentOf: (r: FunnelUsageRow) => string, since: number): FunnelLine[] {
  const agentBySession = new Map<string, string>();
  for (const r of rows) if (r.session && r.agent) agentBySession.set(r.session, r.agent);
  const mcp = (tool: string) => rows.filter((r) => r.tool === tool && (tool !== "read_skill" || r.found)).map((r) => ({ agent: agentOf(r), t: Date.parse(r.ts) }));
  const mcpSearches = mcp("search_skills"), mcpReads = mcp("read_skill");
  const gateRows = rows.filter((r) => r.tool === "gate" && r.session).map((r) => ({ session: r.session!, reason: r.reason, t: Date.parse(r.ts) }));
  const by = new Map<string, FunnelLine>();
  const line = (agent: string) => {
    let l = by.get(agent);
    if (!l) by.set(agent, l = { agent, taskTurns: 0, worked: 0, workedNoSearch: 0, refusals: 0, refusedTurns: 0, searchedAfter: 0, searched: 0, loadedAfter: 0, steppedAside: 0, borrowed: 0 });
    return l;
  };

  for (const s of sessionLogs(since)) {
    const agent = agentBySession.get(s.session) ?? "unknown";
    const marks = s.turns.map((r) => r.ts as number).sort((a, b) => a - b);
    const lastActivity = Math.max(0, ...[...s.turns, ...s.gate, ...s.tools, ...s.loaded].map((r) => r.ts as number));
    for (const task of s.gate.filter((r) => r.kind === "task" && r.ts >= since)) {
      const start = [...marks].reverse().find((t) => t <= task.ts) ?? task.ts;
      // The last turn of a session ends a minute after its last record, so it cannot borrow a later session's search.
      const end = marks.find((t) => t > start) ?? lastActivity + 60_000;
      const inside = (t: number) => t >= start && t < end;
      const l = line(agent);
      l.taskTurns++;
      const refusals = gateRows.filter((g) => g.session === s.session && g.reason === "denied" && inside(g.t)).map((g) => g.t).sort((a, b) => a - b);
      const worked = s.tools.some((r) => !r.sub && inside(r.ts)) || refusals.length > 0;
      const own = s.gate.filter((r) => r.kind === "searched" && !r.sub && inside(r.ts));
      const ownSearches = own.filter((r) => r.via !== "load").map((r) => r.ts as number);
      const ownLoads = [...own.filter((r) => r.via === "load"), ...s.loaded.filter((r) => !r.sub && inside(r.ts))].map((r) => r.ts as number);
      // No search of its own in this turn: borrow the router's log for this agent in the same span.
      const searches = (ownSearches.length ? ownSearches : mcpSearches.filter((m) => m.agent === agent && inside(m.t)).map((m) => m.t)).sort((a, b) => a - b);
      const loads = (ownLoads.length ? ownLoads : mcpReads.filter((m) => m.agent === agent && inside(m.t)).map((m) => m.t)).sort((a, b) => a - b);
      if (!ownSearches.length && searches.length) l.borrowed++;
      const lookups = [...searches, ...loads].sort((a, b) => a - b); // what satisfies the gate: a search or a load
      if (worked) { l.worked++; if (!lookups.length) l.workedNoSearch++; }
      if (refusals.length) { l.refusedTurns++; l.refusals += refusals.length; if (lookups.some((t) => t > refusals[0])) l.searchedAfter++; }
      if (searches.length) { l.searched++; if (loads.some((t) => t >= searches[0])) l.loadedAfter++; }
      if (gateRows.some((g) => g.session === s.session && g.reason === "stepped_aside" && inside(g.t))) l.steppedAside++;
    }
  }
  return [...by.values()].sort((a, b) => b.taskTurns - a.taskTurns);
}

export function funnelLines(funnel: FunnelLine[], days: number): string[] {
  if (!funnel.some((l) => l.taskTurns)) return [];
  const out = ["", "Search gate, per agent (sessions still on disk, kept 7 days; a turn is one prompt that describes a task):"];
  for (const l of funnel) {
    out.push(`  ${l.agent}: ${l.taskTurns} task turns; ${l.worked} did work, ${l.workedNoSearch} of those with no search or load; ` +
      `${l.refusals} refusals in ${l.refusedTurns} turns, a search followed in ${l.searchedAfter}; ${l.loadedAfter} of ${l.searched} turns with a search then loaded a skill; stepped aside in ${l.steppedAside}` + (l.borrowed ? `; ${l.borrowed} turns' searches come from the MCP log, not the session's own record` : ""));
  }
  out.push("  Where a turn has no search record of its own, the router's MCP log for that agent in the same span stands in, which can borrow another session's search." + (days > 7 ? " Sessions older than 7 days have been cleaned up." : ""));
  return out;
}
