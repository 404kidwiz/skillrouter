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

/** The part of a sorted list inside [lo, hi): two binary searches, so a long log is not rescanned for every turn. */
function between(sorted: number[], lo: number, hi: number): number[] {
  const lower = (x: number) => { let a = 0, b = sorted.length; while (a < b) { const m = (a + b) >> 1; if (sorted[m] < x) a = m + 1; else b = m; } return a; };
  return sorted.slice(lower(lo), lower(hi));
}

const finite = (t: unknown): t is number => typeof t === "number" && Number.isFinite(t);

/**
 * How the search gate works out in practice, per agent, over the sessions still on disk (state is kept 7 days). A turn is the
 * span from one prompt's marker to the next; one prompt counts once, however often its hook ran. Searches and loads come from
 * the session's own logs (the gate hook records searches and loads itself; the post-tool hook records loads). Only a session
 * with no records of its own (Codex before its hook was trusted) borrows from the router's MCP log, by agent and time, and each
 * MCP row is lent to one turn at most, so one search is never credited to two sessions.
 */
export function gateFunnel(rows: FunnelUsageRow[], agentOf: (r: FunnelUsageRow) => string, since: number, now = Date.now()): FunnelLine[] {
  const counts = new Map<string, Map<string, number>>();
  for (const r of rows) if (r.session && r.agent) { const m = counts.get(r.session) ?? new Map<string, number>(); m.set(r.agent, (m.get(r.agent) ?? 0) + 1); counts.set(r.session, m); }
  // The agent a session mostly belongs to; a session id shared by two hosts is credited to the one that used it more.
  const agentBySession = new Map([...counts].map(([s, m]) => [s, [...m].sort((a, b) => b[1] - a[1])[0][0]]));

  const sortedTimes = (pick: (r: FunnelUsageRow) => boolean) => {
    const by = new Map<string, number[]>();
    for (const r of rows) if (pick(r)) { const t = Date.parse(r.ts); if (finite(t)) { const a = by.get(agentOf(r)) ?? []; a.push(t); by.set(agentOf(r), a); } }
    for (const a of by.values()) a.sort((x, y) => x - y);
    return by;
  };
  const mcpSearches = sortedTimes((r) => r.tool === "search_skills");
  const mcpReads = sortedTimes((r) => r.tool === "read_skill" && !!r.found);
  const lent = new Set<string>(); // "kind:agent:time" of MCP rows already credited to a turn

  const gateBySession = new Map<string, { denied: number[]; aside: number[] }>();
  for (const r of rows) {
    if (r.tool !== "gate" || !r.session) continue;
    const t = Date.parse(r.ts); if (!finite(t)) continue;
    const g = gateBySession.get(r.session) ?? { denied: [], aside: [] };
    if (r.reason === "denied") g.denied.push(t); else if (r.reason === "stepped_aside") g.aside.push(t);
    gateBySession.set(r.session, g);
  }
  for (const g of gateBySession.values()) { g.denied.sort((x, y) => x - y); g.aside.sort((x, y) => x - y); }

  const by = new Map<string, FunnelLine>();
  const line = (agent: string) => {
    let l = by.get(agent);
    if (!l) by.set(agent, l = { agent, taskTurns: 0, worked: 0, workedNoSearch: 0, refusals: 0, refusedTurns: 0, searchedAfter: 0, searched: 0, loadedAfter: 0, steppedAside: 0, borrowed: 0 });
    return l;
  };

  type Turn = { session: string; agent: string; start: number; end: number; s: ReturnType<typeof sessionLogs>[number]; hookSeen: boolean };
  const turns: Turn[] = [];
  for (const s of sessionLogs(since)) {
    const agent = agentBySession.get(s.session) ?? "unknown";
    const g = gateBySession.get(s.session);
    // Rows from the future (a clock set wrong) are not evidence of anything.
    const ok = (r: any) => finite(r?.ts) && r.ts <= now + 60_000;
    const gate = s.gate.filter(ok), loaded = s.loaded.filter(ok), tools = s.tools.filter(ok);
    // One marker per turn id, so a prompt whose hook ran twice is still one turn.
    const seen = new Set<string>();
    const marks = s.turns.filter(ok).filter((r) => { if (!r.turn) return true; if (seen.has(r.turn)) return false; seen.add(r.turn); return true; }).map((r) => r.ts as number).sort((a, b) => a - b);
    const lastActivity = [...s.turns.filter(ok), ...gate, ...tools, ...loaded].reduce((m, r) => Math.max(m, r.ts as number), [...(g?.denied ?? []), ...(g?.aside ?? [])].reduce((m, t) => Math.max(m, t), 0));
    const hookSeen = gate.some((r) => r.kind === "searched") || !!g; // the gate hook ran in this session, so its records are complete
    const tasks = new Set<string>();
    for (const task of gate.filter((r) => r.kind === "task" && r.ts >= since)) {
      if (task.turn) { if (tasks.has(task.turn)) continue; tasks.add(task.turn); }
      const start = [...marks].reverse().find((t) => t <= task.ts) ?? task.ts;
      // The last turn of a session ends a minute after its last record, so it cannot borrow a later session's search.
      const end = marks.find((t) => t > start) ?? lastActivity + 60_000;
      turns.push({ session: s.session, agent, start, end, s: { ...s, gate, loaded, tools }, hookSeen });
    }
  }
  turns.sort((a, b) => a.start - b.start); // an MCP row goes to the earliest turn that could own it

  for (const t of turns) {
    const { s, agent, start, end } = t;
    const inside = (x: number) => x >= start && x < end;
    const l = line(agent);
    l.taskTurns++;
    const g = gateBySession.get(s.session);
    const refusals = between(g?.denied ?? [], start, end);
    const worked = s.tools.some((r) => !r.sub && inside(r.ts)) || refusals.length > 0;
    const own = s.gate.filter((r) => r.kind === "searched" && !r.sub && inside(r.ts));
    const ownSearches = own.filter((r) => r.via !== "load").map((r) => r.ts as number);
    const ownLoads = [...own.filter((r) => r.via === "load"), ...s.loaded.filter((r) => !r.sub && inside(r.ts))].map((r) => r.ts as number);
    const borrow = (kind: string, list: Map<string, number[]>) => between(list.get(agent) ?? [], start, end).filter((x) => { const k = `${kind}:${agent}:${x}`; if (lent.has(k)) return false; lent.add(k); return true; });
    // A session whose hooks ran has complete records of its own; only one with none borrows from the router's log.
    const searches = (ownSearches.length || t.hookSeen ? ownSearches : borrow("s", mcpSearches)).sort((a, b) => a - b);
    const loads = (ownLoads.length || t.hookSeen || s.loaded.length ? ownLoads : borrow("r", mcpReads)).sort((a, b) => a - b);
    if (!ownSearches.length && !t.hookSeen && searches.length) l.borrowed++;
    const lookups = [...searches, ...loads].sort((a, b) => a - b); // what satisfies the gate: a search or a load
    if (worked) { l.worked++; if (!lookups.length) l.workedNoSearch++; }
    if (refusals.length) { l.refusedTurns++; l.refusals += refusals.length; if (lookups.some((x) => x > refusals[0])) l.searchedAfter++; }
    if (searches.length) { l.searched++; if (loads.some((x) => x >= searches[0])) l.loadedAfter++; }
    if (between(g?.aside ?? [], start, end).length) l.steppedAside++;
  }
  return [...by.values()].sort((a, b) => b.taskTurns - a.taskTurns);
}

const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;

export function funnelLines(funnel: FunnelLine[], days: number): string[] {
  if (!funnel.some((l) => l.taskTurns)) return [];
  const out = ["", "Search gate, per agent (sessions still on disk, kept 7 days; a turn is one prompt that describes a task):"];
  for (const l of funnel) {
    out.push(`  ${l.agent}: ${plural(l.taskTurns, "task turn")}; ${l.worked} did work, ${l.workedNoSearch} of those with no search or load; ` +
      `${plural(l.refusals, "refusal")} in ${plural(l.refusedTurns, "turn")}, a search or load followed in ${l.searchedAfter}; ` +
      `${l.loadedAfter} of ${plural(l.searched, "turn")} with a search then loaded a skill; stepped aside in ${l.steppedAside}` +
      (l.borrowed ? `; ${l.borrowed === 1 ? "1 turn's search comes" : `${l.borrowed} turns' searches come`} from the MCP log, not the session's own record` : ""));
  }
  out.push("  Where a session has no records of its own, the router's MCP log for that agent in the same span stands in; each of its rows is credited to one turn at most." + (days > 7 ? " Sessions older than 7 days have been cleaned up." : ""));
  return out;
}
