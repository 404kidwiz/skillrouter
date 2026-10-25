// The report's search-gate funnel: per agent, from the session logs on disk and the usage log.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "skillrouter-b18-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.SKILLROUTER_HOME = path.join(home, ".skillrouter");
process.env.SKILLROUTER_SERVICE = "0";
fs.mkdirSync(process.env.SKILLROUTER_HOME, { recursive: true });
process.on("exit", () => fs.rmSync(home, { recursive: true, force: true }));
const { markTurn, addGateTask, addTool, addSearched, addLoaded } = await import("../src/state.js");
const { gateFunnel, funnelLines } = await import("../src/funnel.js");
const { report, readLog, agentOf } = await import("../src/report.js");
const { logUsage } = await import("../src/search.js");

const hex = (c: string) => c.repeat(64);
const tick = () => new Promise((r) => setTimeout(r, 4)); // state rows carry the millisecond: keep one step apart
const use = (agent: string, session: string, tool: string, extra: Record<string, unknown> = {}) => logUsage({ client: `hook/${agent}`, agent, tool, session, ...extra } as any);

// Claude: a refusal, then a search, then a load.
const s1 = hex("a");
use("claude", s1, "hint", { reason: "shown" });
markTurn(s1, "t1"); await tick(); addGateTask(s1, "t1"); await tick(); addTool(s1, "t1"); await tick();
use("claude", s1, "gate", { reason: "denied", prompt: "t1" }); await tick();
addSearched(s1, "t1", undefined, "search"); await tick(); addLoaded(s1, "python-testing"); await tick();
// Claude: loaded a skill without searching; and a conversational turn that is never marked a task.
const s6 = hex("b");
use("claude", s6, "hint", { reason: "shown" });
markTurn(s6, "t1"); await tick(); addGateTask(s6, "t1"); await tick(); addTool(s6, "t1"); await tick(); addSearched(s6, "t1", undefined, "load"); await tick();
const s3 = hex("c");
use("claude", s3, "hint", { reason: "no_match" });
markTurn(s3, "t1"); await tick(); addTool(s3, "t1"); await tick();
// Codex: worked with no search at all, then a task turn with no work.
const s2 = hex("d");
use("codex", s2, "hint", { reason: "shown" });
markTurn(s2, "t1"); await tick(); addGateTask(s2, "t1"); await tick(); addTool(s2, "t1"); await tick();
markTurn(s2, "t2"); await tick(); addGateTask(s2, "t2"); await tick();
// Codex: refused twice, never searched, the gate stepped aside.
const s4 = hex("e");
use("codex", s4, "hint", { reason: "shown" });
markTurn(s4, "t1"); await tick(); addGateTask(s4, "t1"); await tick();
use("codex", s4, "gate", { reason: "denied", prompt: "t1" }); await tick(); use("codex", s4, "gate", { reason: "denied", prompt: "t1" }); await tick();
use("codex", s4, "gate", { reason: "stepped_aside", prompt: "t1" }); await tick();
// Gemini: no search of its own; the router's log has one, then a load.
const s5 = hex("f");
use("gemini", s5, "hint", { reason: "shown" });
markTurn(s5, "t1"); await tick(); addGateTask(s5, "t1"); await tick(); addTool(s5, "t1"); await tick();
logUsage({ client: "gemini-cli/1", agent: "gemini", tool: "search_skills", query: "x", hits: [] } as any); await tick();
logUsage({ client: "gemini-cli/1", agent: "gemini", tool: "read_skill", skill: "pdf", found: true } as any); await tick();

const funnel = () => Object.fromEntries(gateFunnel(readLog(1).filter((r) => !/probe/.test(r.client)), agentOf, Date.now() - 86400e3).map((l) => [l.agent, l]));

test("per agent: task turns, work, work with no search, refusals, searches after them, loads after a search, stepped aside", () => {
  const f = funnel();
  assert.deepEqual(f.claude, { agent: "claude", taskTurns: 2, worked: 2, workedNoSearch: 0, refusals: 1, refusedTurns: 1, searchedAfter: 1, searched: 1, loadedAfter: 1, steppedAside: 0, borrowed: 0 },
    "a load alone satisfies the gate but is not a search; the conversational turn is not a task turn");
  assert.deepEqual(f.codex, { agent: "codex", taskTurns: 3, worked: 2, workedNoSearch: 2, refusals: 2, refusedTurns: 1, searchedAfter: 0, searched: 0, loadedAfter: 0, steppedAside: 1, borrowed: 0 },
    "refusals count as work; the last turn of a session cannot borrow another session's search");
  assert.deepEqual(f.gemini, { agent: "gemini", taskTurns: 1, worked: 1, workedNoSearch: 0, refusals: 0, refusedTurns: 0, searchedAfter: 0, searched: 1, loadedAfter: 1, steppedAside: 0, borrowed: 1 },
    "with no record of its own, the router's MCP log supplies the search and the load, and says so");
});

test("sessions older than the window are left out, and a quiet log prints no section", () => {
  assert.deepEqual(gateFunnel(readLog(1), agentOf, Date.now() + 60_000), []);
  assert.deepEqual(funnelLines([], 7), []);
  assert.deepEqual(funnelLines(gateFunnel([], agentOf, Date.now() + 60_000), 7), []);
});

test("report prints the funnel under the hint sections, with its caveat", () => {
  const text = report(1);
  assert.match(text, /Search gate, per agent \(sessions still on disk, kept 7 days; a turn is one prompt that describes a task\):/);
  assert.match(text, /\n  claude: 2 task turns; 2 did work, 0 of those with no search or load; 1 refusals in 1 turns, a search followed in 1; 1 of 1 turns with a search then loaded a skill; stepped aside in 0\n/);
  assert.match(text, /\n  codex: 3 task turns; 2 did work, 2 of those with no search or load; 2 refusals in 1 turns, a search followed in 0; 0 of 0 turns with a search then loaded a skill; stepped aside in 1\n/);
  assert.match(text, /\n  gemini: 1 task turns;[^\n]*; 1 turns' searches come from the MCP log, not the session's own record\n/);
  assert.match(text, /borrow another session's search/);
});

test("the gate hook records a search or a load as such, so the funnel can tell them apart", async () => {
  const { gateEvent } = await import("../src/gate.js");
  const { hint, sessionHash } = await import("../src/hint.js");
  const { saveIndex } = await import("../src/index.js");
  saveIndex({ builtAt: "g", roots: [], tokenizer: 2, skills: [] } as any);
  for (const [tool, input, via] of [["mcp__skillrouter__search_skills", { query: "x" }, "search"], ["Skill", { skill: "pdf" }, "load"], ["mcp__skillrouter__read_skill", { id: "pdf" }, "load"]] as const) {
    const s = `fun-${via}-${tool}`;
    await hint("claude", JSON.stringify({ session_id: s, prompt_id: "p1", prompt: "write pytest tests for the api client and fix the failing fixtures" }));
    assert.equal(gateEvent("claude", JSON.stringify({ session_id: s, prompt_id: "p1", tool_name: tool, tool_input: input })), "");
    const row = fs.readFileSync(path.join(process.env.SKILLROUTER_HOME!, "state", sessionHash(s)!, "gate.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).find((r) => r.kind === "searched");
    assert.equal(row.via, via, tool);
  }
});
