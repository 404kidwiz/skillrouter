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
const { readRecurring, promptKey } = await import("../src/recurring.js");
const { gateFunnel, funnelLines } = await import("../src/funnel.js");
const { readLog, agentOf, report } = await import("../src/report.js");
const { health } = await import("../src/health.js");
const { routeSearch, namedInQuery } = await import("../src/routing.js");
const { toolEvent } = await import("../src/events.js");
const skill = (id, words) => ({ id, name: id, description: `A skill about ${words} with enough description to pass the gate`, path: "/s/" + id, root: "/s", tokens: tokenize(`${id.replace(/-/g, " ")} ${words} `.repeat(3)) });
saveIndex({ builtAt: "g1", roots: [], tokenizer: 2, skills: [skill("python-testing", "python testing pytest tests fixtures mocking"), skill("invoice", "invoices billing due dates"),
        skill("skill-library-ops", "skill library maintenance provenance"), skill("error-handling", "errors exceptions retries recovery"), ...Array.from({ length: 30 }, (_, i) => skill(`filler-${i}`, `sourdough kiln glaze number ${i} baking pottery`))] });
fs.writeFileSync(path.join(process.env.SKILLROUTER_HOME, "core.txt"), "");
let n = 0;
const session = () => `b19-${++n}-${Math.random().toString(36).slice(2)}`;
const prompt = (s, text) => hint("codex", JSON.stringify({ session_id: s, turn_id: "t1", prompt: text }));
const work = (s) => gateEvent("codex", JSON.stringify({ session_id: s, turn_id: "t1", tool_name: "Bash", tool_input: { command: "pytest -q" } }));
const searchCall = (s) => gateEvent("codex", JSON.stringify({ session_id: s, turn_id: "t1", tool_name: "mcp__skillrouter__search_skills", tool_input: { query: "x" } }));
const rows = () => fs.readFileSync(path.join(process.env.SKILLROUTER_HOME, "usage.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
test("a recurring request refused in two runs with no search is let through after that, until a run searches again", async () => {
    // Seen on a Mac, 2026-11-11 to 15: an hourly job ended each run at the refusal, 88 runs, and nobody saw it.
    const job = "run the hourly upkeep scripts and report failures for pytest fixtures";
    for (let run = 1; run <= 2; run++) {
        const s = session();
        await prompt(s, job);
        assert.equal(work(s), formatGate("codex", GATE_REASON), `run ${run} is refused as usual`);
        assert.equal(work(s), formatGate("codex", GATE_REASON_LAST), `run ${run} keeps its second refusal, the one that says it is the last`);
        // ...and the agent ends the run there.
    }
    const third = session();
    await prompt(third, job);
    assert.equal(work(third), "", "the third run is not refused");
    assert.equal(rows().filter((r) => r.reason === "stepped_aside_recurring").length, 1, "and the log says why");
    // A run that does search clears the record: the next run is asked again.
    const s4 = session();
    await prompt(s4, job);
    assert.equal(searchCall(s4), "");
    const s5 = session();
    await prompt(s5, job);
    assert.equal(work(s5), formatGate("codex", GATE_REASON), "after a run that searched, the request is gated again");
    // Another request is unaffected throughout.
    const other = session();
    await prompt(other, "write pytest fixtures for the billing client and fix the mocking");
    assert.equal(work(other), formatGate("codex", GATE_REASON));
    const e = Object.values(readRecurring().prompts).find((x) => x.refused >= 1);
    assert.ok(e, "runs are counted in the recurring store (hash only, no text)");
    assert.equal(work(third), "", "the rest of the let-through turn is not refused either");
    assert.ok(!JSON.stringify(readRecurring()).includes("upkeep"), "the request text is never stored");
});
test("SKILLROUTER_GATE_STALL_RUNS=0 keeps refusing; within one run the two-refusal limit is unchanged", async () => {
    process.env.SKILLROUTER_GATE_STALL_RUNS = "0";
    try {
        const job = "regenerate the nightly pytest fixtures report for the kiln python service";
        for (let run = 1; run <= 3; run++) {
            const s = session();
            await prompt(s, job);
            assert.notEqual(work(s), "", `run ${run} refused`);
        }
    }
    finally {
        delete process.env.SKILLROUTER_GATE_STALL_RUNS;
    }
    const s = session();
    await prompt(s, "port the python mocking helpers to pytest fixtures in the glaze service");
    assert.deepEqual([work(s), work(s), work(s)], [formatGate("codex", GATE_REASON), formatGate("codex", GATE_REASON_LAST), ""]);
});
test("a refused turn that then ends is counted as stopped, and doctor warns about it", async () => {
    const s = session();
    await prompt(s, "migrate the python pytest fixtures to the new mocking layout for pottery");
    assert.notEqual(work(s), "");
    const since = Date.now() - 3600e3;
    const line = gateFunnel(readLog(1), agentOf, since).find((l) => l.agent === "codex");
    assert.ok(line.stalled >= 1, "the turn that stopped is counted");
    assert.match(funnelLines([line], 1).join("\n"), /STOPPED after a refusal in \d+/);
    assert.match(health(home).join("\n"), /WARNING: in the last 24 hours codex \d+ task turn\(s\) stopped after a search-gate refusal/);
    // A refused turn that searched afterwards is not stopped.
    const ok = session();
    await prompt(ok, "add pytest fixtures for the glaze python client mocking retries");
    work(ok);
    searchCall(ok);
    const after = gateFunnel(readLog(1), agentOf, since).find((l) => l.agent === "codex");
    assert.equal(after.stalled, line.stalled, "searching after the refusal is not a stop");
});
test("report can be read from a date, so rows before a change do not blur it", () => {
    const text = report(1 / 24, readLog(1 / 24), "Since 2026-11-17 01:00 UTC");
    assert.match(text, /^Since 2026-11-17 01:00 UTC: \d+ searches/);
});
test("runs are counted per turn: the same request in two turns of one session is two runs, and any search clears the count", async () => {
    const job = "rebuild the kiln python pytest fixtures inventory for the weekly glaze run";
    const s = session();
    for (const t of ["a1", "a2"]) {
        await hint("codex", JSON.stringify({ session_id: s, turn_id: t, prompt: job }));
        const call = () => gateEvent("codex", JSON.stringify({ session_id: s, turn_id: t, tool_name: "Bash", tool_input: { command: "pytest -q" } }));
        assert.equal(call(), formatGate("codex", GATE_REASON), `turn ${t} is refused`);
        assert.equal(gateEvent("codex", JSON.stringify({ session_id: s, turn_id: t, tool_name: "mcp__skillrouter__search_skills", tool_input: { query: "x" } })), "");
    }
    const refused = () => readRecurring().prompts[promptKey(job)]?.refused;
    assert.equal(refused(), 0, "each turn searched after its refusal");
    // Interleaved runs: two refused, then both search. The count goes back to zero, so a third run is asked again.
    const a = session(), b = session();
    await prompt(a, job);
    await prompt(b, job);
    work(a);
    work(b);
    searchCall(a);
    searchCall(b);
    const c = session();
    await prompt(c, job);
    assert.equal(work(c), formatGate("codex", GATE_REASON), "every run searched, so the request is still gated");
    assert.equal(refused(), 1, "only the run still waiting counts");
});
test("STOPPED counts only turns that really stopped: subagent work or a let-through carries the turn on; probes are left out of doctor", async () => {
    const since = Date.now() - 3600e3;
    const stalledNow = () => gateFunnel(readLog(1), agentOf, since).filter((l) => l.agent === "claude").reduce((n, l) => n + l.stalled, 0);
    const before = stalledNow();
    // Refused, then the work went to a subagent (not gated, recorded with agent_id).
    const s = session();
    await hint("claude", JSON.stringify({ session_id: s, prompt_id: "p1", prompt: "refactor the python pytest fixtures for the pottery kiln inventory service" }));
    assert.notEqual(gateEvent("claude", JSON.stringify({ session_id: s, prompt_id: "p1", tool_name: "Bash", tool_input: { command: "pytest -q" } })), "");
    await toolEvent("claude", JSON.stringify({ session_id: s, prompt_id: "p1", agent_id: "sub-1", tool_name: "Bash", tool_input: { command: "pytest -q" }, tool_use_id: "sub-work" }), false);
    assert.equal(stalledNow(), before, "work in a subagent is the turn carrying on");
    // A probe client's stopped turn is not a warning about the user's agents.
    const rowsBefore = rows().length;
    fs.appendFileSync(path.join(process.env.SKILLROUTER_HOME, "usage.jsonl"), JSON.stringify({ ts: new Date().toISOString(), client: "smoke-probe", agent: "gemini", tool: "gate", reason: "denied", session: "probe-session" }) + "\n");
    assert.equal(rows().length, rowsBefore + 1);
    assert.doesNotMatch(health(home).join("\n"), /WARNING:[^\n]*gemini/, "synthetic clients do not raise the warning");
});
test("a hyphenated skill name inside a longer query comes first and the ranked results stay; a plain word that is also a skill name is a topic", async () => {
    const ids = async (q) => (await routeSearch(q, { k: 5, lexicalOnly: true })).hits.map((h) => h.skill.id);
    assert.deepEqual((await ids("skill-library-ops upstream provenance comparison"))[0], "skill-library-ops");
    const mixed = await ids("python pytest fixtures mocking tests with error-handling");
    assert.equal(mixed[0], "error-handling", "the named skill leads");
    assert.ok(mixed.includes("python-testing"), "and the ranker's answer is still there");
    assert.ok(!(await ids("edit invoice due dates")).slice(0, 1).includes("skill-library-ops"));
    assert.deepEqual(namedInQuery("compare skill-library-ops with error-handling"), [], "two named skills: neither is put first");
    assert.deepEqual(namedInQuery("edit invoice due dates"), [], "a plain word is never a name here");
});
test("SKILLROUTER_GATE_STALL_RUNS: empty means the default, a bad value too; report --since rejects a bad date", async () => {
    const { stallRuns } = await import("../src/recurring.js");
    for (const [v, want] of [["", 2], ["  ", 2], ["3", 3], ["0", 0], ["-1", 2], ["x", 2]]) {
        process.env.SKILLROUTER_GATE_STALL_RUNS = v;
        assert.equal(stallRuns(), want, JSON.stringify(v));
    }
    delete process.env.SKILLROUTER_GATE_STALL_RUNS;
    const { spawnSync } = await import("node:child_process");
    const cli = new URL("../src/cli.js", import.meta.url).pathname;
    for (const bad of [["--since"], ["--since", "not-a-date"], ["--since", "2999-01-01"]]) {
        const r = spawnSync(process.execPath, [cli, "report", ...bad], { encoding: "utf8", env: process.env });
        assert.equal(r.status, 1, bad.join(" "));
        assert.match(r.stdout, /usage: skillrouter report/);
    }
});
