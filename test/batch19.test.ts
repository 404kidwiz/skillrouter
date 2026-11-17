// What the search gate costs when it goes wrong: a request it keeps stopping is let through, a stopped turn is
// counted and named by doctor, and the report can be read from a given date. Plus: a skill named inside a query.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "skillrouter-b19-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.SKILLROUTER_HOME = path.join(home, ".skillrouter");
process.env.SKILLROUTER_SERVICE = "0";
fs.mkdirSync(process.env.SKILLROUTER_HOME, { recursive: true });
delete process.env.SKILLROUTER_GATE;
delete process.env.SKILLROUTER_GATE_STALL_RUNS;
delete process.env.SKILLROUTER_RECURRING;
const { gateEvent, formatGate, GATE_REASON, GATE_REASON_LAST } = await import("../src/gate.js");
const { hint } = await import("../src/hint.js");
const { saveIndex } = await import("../src/index.js");
const { tokenize } = await import("../src/bm25.js");
const { readRecurring } = await import("../src/recurring.js");
const { gateFunnel, funnelLines } = await import("../src/funnel.js");
const { readLog, agentOf, report } = await import("../src/report.js");
const { health } = await import("../src/health.js");
const { namedSkill } = await import("../src/routing.js");

const skill = (id: string, words: string) => ({ id, name: id, description: `A skill about ${words} with enough description to pass the gate`, path: "/s/" + id, root: "/s", tokens: tokenize(`${id.replace(/-/g, " ")} ${words} `.repeat(3)) });
saveIndex({ builtAt: "g1", roots: [], tokenizer: 2, skills: [skill("python-testing", "python testing pytest tests fixtures mocking"), skill("invoice", "invoices billing due dates"),
  skill("skill-library-ops", "skill library maintenance provenance"), ...Array.from({ length: 30 }, (_, i) => skill(`filler-${i}`, `sourdough kiln glaze number ${i} baking pottery`))] } as any);
fs.writeFileSync(path.join(process.env.SKILLROUTER_HOME, "core.txt"), "");

let n = 0;
const session = () => `b19-${++n}-${Math.random().toString(36).slice(2)}`;
const prompt = (s: string, text: string) => hint("codex", JSON.stringify({ session_id: s, turn_id: "t1", prompt: text }));
const work = (s: string) => gateEvent("codex", JSON.stringify({ session_id: s, turn_id: "t1", tool_name: "Bash", tool_input: { command: "pytest -q" } }));
const searchCall = (s: string) => gateEvent("codex", JSON.stringify({ session_id: s, turn_id: "t1", tool_name: "mcp__skillrouter__search_skills", tool_input: { query: "x" } }));
const rows = () => fs.readFileSync(path.join(process.env.SKILLROUTER_HOME!, "usage.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

test("a recurring request refused in two runs with no search is let through after that, until a run searches again", async () => {
  // Seen on a Mac, 2026-11-11 to 15: an hourly job ended each run at the refusal, 88 runs, and nobody saw it.
  const job = "run the hourly upkeep scripts and report failures for pytest fixtures";
  for (let run = 1; run <= 2; run++) {
    const s = session(); await prompt(s, job);
    assert.equal(work(s), formatGate("codex", GATE_REASON), `run ${run} is refused as usual`);
    // ...and the agent ends the run there.
  }
  const third = session(); await prompt(third, job);
  assert.equal(work(third), "", "the third run is not refused");
  assert.equal(rows().filter((r) => r.reason === "stepped_aside_recurring").length, 1, "and the log says why");
  // A run that does search clears the record: the next run is asked again.
  const s4 = session(); await prompt(s4, job);
  assert.equal(searchCall(s4), "");
  const s5 = session(); await prompt(s5, job);
  assert.equal(work(s5), formatGate("codex", GATE_REASON), "after a run that searched, the request is gated again");
  // Another request is unaffected throughout.
  const other = session(); await prompt(other, "write pytest fixtures for the billing client and fix the mocking");
  assert.equal(work(other), formatGate("codex", GATE_REASON));
  const e = Object.values(readRecurring().prompts).find((x: any) => x.refused >= 1) as any;
  assert.ok(e, "runs are counted in the recurring store (hash only, no text)");
  assert.ok(!JSON.stringify(readRecurring()).includes("upkeep"), "the request text is never stored");
});

test("SKILLROUTER_GATE_STALL_RUNS=0 keeps refusing; within one run the two-refusal limit is unchanged", async () => {
  process.env.SKILLROUTER_GATE_STALL_RUNS = "0";
  try {
    const job = "regenerate the nightly pytest fixtures report for the kiln python service";
    for (let run = 1; run <= 3; run++) { const s = session(); await prompt(s, job); assert.notEqual(work(s), "", `run ${run} refused`); }
  } finally { delete process.env.SKILLROUTER_GATE_STALL_RUNS; }
  const s = session(); await prompt(s, "port the python mocking helpers to pytest fixtures in the glaze service");
  assert.deepEqual([work(s), work(s), work(s)], [formatGate("codex", GATE_REASON), formatGate("codex", GATE_REASON_LAST), ""]);
});

test("a refused turn that then ends is counted as stopped, and doctor warns about it", async () => {
  const s = session(); await prompt(s, "migrate the python pytest fixtures to the new mocking layout for pottery");
  assert.notEqual(work(s), "");
  const since = Date.now() - 3600e3;
  const line = gateFunnel(readLog(1), agentOf, since).find((l) => l.agent === "codex")!;
  assert.ok(line.stalled >= 1, "the turn that stopped is counted");
  assert.match(funnelLines([line], 1).join("\n"), /STOPPED after a refusal in \d+/);
  assert.match(health(home).join("\n"), /WARNING: in the last 24 hours codex \d+ task turn\(s\) stopped after a search-gate refusal/);
  // A refused turn that searched afterwards is not stopped.
  const ok = session(); await prompt(ok, "add pytest fixtures for the glaze python client mocking retries");
  work(ok); searchCall(ok);
  const after = gateFunnel(readLog(1), agentOf, since).find((l) => l.agent === "codex")!;
  assert.equal(after.stalled, line.stalled, "searching after the refusal is not a stop");
});

test("report can be read from a date, so rows before a change do not blur it", () => {
  const text = report(1 / 24, readLog(1 / 24), "Since 2026-11-17 01:00 UTC");
  assert.match(text, /^Since 2026-11-17 01:00 UTC: \d+ searches/);
});

test("a hyphenated skill name inside a longer query names that skill; a plain word that is also a skill name does not", () => {
  assert.deepEqual(namedSkill("skill-library-ops upstream provenance comparison").map((s) => s.id), ["skill-library-ops"]);
  assert.deepEqual(namedSkill("skill-library-ops").map((s) => s.id), ["skill-library-ops"], "the whole query as before");
  assert.deepEqual(namedSkill("edit invoice due date"), [], "'invoice' is a topic here, not a request for that skill");
  assert.deepEqual(namedSkill("compare skill-library-ops with python-testing"), [], "two named skills: no single answer");
});
