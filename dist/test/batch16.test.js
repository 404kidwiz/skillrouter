// The search gate: on a task turn the first work call is refused until the agent has searched or loaded a skill.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const home = fs.mkdtempSync(path.join(os.tmpdir(), "skillrouter-b16-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.SKILLROUTER_HOME = path.join(home, ".skillrouter");
process.env.SKILLROUTER_SERVICE = "0";
fs.mkdirSync(process.env.SKILLROUTER_HOME, { recursive: true });
delete process.env.SKILLROUTER_GATE;
const { gateEvent, formatGate, GATE_MAX_DENIALS, GATE_REASON } = await import("../src/gate.js");
const { toolEvent } = await import("../src/events.js");
const { hint } = await import("../src/hint.js");
const { saveIndex } = await import("../src/index.js");
const { tokenize } = await import("../src/bm25.js");
const skill = (id, words) => ({ id, name: id, description: `A skill about ${words} with enough description to pass the gate`, path: "/s/" + id, root: "/s", tokens: tokenize(`${id.replace(/-/g, " ")} ${words} `.repeat(3)) });
saveIndex({ builtAt: "g1", roots: [], tokenizer: 2, skills: [skill("python-testing", "python testing pytest tests fixtures mocking"), ...Array.from({ length: 30 }, (_, i) => skill(`filler-${i}`, `sourdough kiln glaze number ${i} baking pottery`))] });
fs.writeFileSync(path.join(process.env.SKILLROUTER_HOME, "core.txt"), "");
let n = 0;
const session = () => `gate-session-${++n}-${Math.random().toString(36).slice(2)}`;
const prompt = (s, turn, text, agent = "claude") => hint(agent, JSON.stringify({ session_id: s, prompt_id: turn, prompt: text }));
const work = (s, turn, extra = {}) => ({ session_id: s, prompt_id: turn, tool_name: "Bash", tool_input: { command: "pytest -q" }, ...extra });
const gate = (agent, p) => gateEvent(agent, JSON.stringify(p));
const task = "write pytest tests for the api client and fix the failing python fixtures";
test("a task turn's first work call is refused with a host-shaped denial that names the next step", async () => {
    const s = session();
    await prompt(s, "t1", task);
    const out = JSON.parse(gate("claude", work(s, "t1")));
    assert.equal(out.hookSpecificOutput.hookEventName, "PreToolUse");
    assert.equal(out.hookSpecificOutput.permissionDecision, "deny");
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /search_skills/);
    assert.equal(GATE_REASON.includes("search_skills"), true);
    assert.deepEqual(JSON.parse(formatGate("gemini")), { decision: "deny", reason: GATE_REASON });
    const cursor = JSON.parse(formatGate("cursor"));
    assert.equal(cursor.permission, "deny");
    assert.equal(cursor.agent_message, GATE_REASON);
    assert.ok(cursor.user_message);
    assert.deepEqual(JSON.parse(formatGate("codex")), JSON.parse(formatGate("claude")));
});
test("a search_skills call in the turn lets the work through, whatever the host calls the tool", async () => {
    for (const tool of ["mcp__skillrouter__search_skills", "mcp__plugin_skillrouter_skillrouter__search_skills", "mcp_skillrouter_search_skills", "skillrouter_search_skills", "MCP:search_skills"]) {
        const s = session();
        await prompt(s, "t1", task);
        assert.notEqual(gate("claude", work(s, "t1")), "", `${tool}: refused before the search`);
        await toolEvent("claude", JSON.stringify({ session_id: s, prompt_id: "t1", tool_name: tool, tool_input: { query: "pytest tests" }, tool_use_id: "u-" + tool }), false);
        assert.equal(gate("claude", work(s, "t1")), "", `${tool}: allowed after the search`);
    }
});
test("loading a skill in the turn also satisfies the gate: the Skill tool, read_skill, a SKILL.md read", async () => {
    const loads = [["Skill", { skill: "python-testing" }], ["mcp__skillrouter__read_skill", { id: "python-testing" }], ["Read", { file_path: "/home/u/.skills/python-testing/SKILL.md" }]];
    for (const [tool, input] of loads) {
        const s = session();
        await prompt(s, "t1", task);
        await toolEvent("claude", JSON.stringify({ session_id: s, prompt_id: "t1", tool_name: tool, tool_input: input, tool_use_id: "l-" + tool }), false);
        assert.equal(gate("claude", work(s, "t1")), "", tool);
    }
});
test("only work is gated: reads, searches, MCP calls and subagents pass; so does everything on a turn that isn't a task", async () => {
    const s = session();
    await prompt(s, "t1", task);
    for (const [tool, input] of [["Read", { file_path: "/repo/src/a.py" }], ["Grep", { pattern: "x" }], ["Bash", { command: "ls -la src" }], ["Bash", { command: "git status" }], ["mcp__other__thing", { a: 1 }]])
        assert.equal(gate("claude", { session_id: s, prompt_id: "t1", tool_name: tool, tool_input: input }), "", `${tool} ${JSON.stringify(input)}`);
    for (const [tool, input] of [["Edit", { file_path: "/repo/a.py", old_string: "a", new_string: "b" }], ["Write", { file_path: "/repo/a.py", content: "x" }], ["Bash", { command: "npm test" }], ["Bash", { command: "rm -rf build && make" }]]) {
        const w = session();
        await prompt(w, "t1", task); // (a fresh session each: the gate stops after two refusals)
        assert.notEqual(gate("claude", { session_id: w, prompt_id: "t1", tool_name: tool, tool_input: input }), "", `${tool} ${JSON.stringify(input)} is work`);
    }
    const sub = session();
    await prompt(sub, "t1", task);
    assert.equal(gate("claude", work(sub, "t1", { agent_id: "agent-7" })), "", "a subagent works from its own brief");
    const talk = session();
    await prompt(talk, "t1", "What is next? Do you have suggestions for improvements before moving forward?");
    assert.equal(gate("claude", work(talk, "t1")), "", "a conversational turn needs no search");
    const none = session();
    assert.equal(gate("claude", work(none, "t1")), "", "no prompt check ever ran for this session: nothing to enforce");
    const sys = session();
    await prompt(sys, "t1", "<task-notification>background task finished with exit code 0</task-notification>");
    assert.equal(gate("claude", work(sys, "t1")), "", "system text is not a task");
    assert.equal(gate("claude", { tool_name: "Bash", tool_input: { command: "npm test" } }), "", "no session id");
});
test("the gate steps aside after two refusals, so an agent that cannot search is never stuck", async () => {
    const s = session();
    await prompt(s, "t1", task);
    const outs = Array.from({ length: GATE_MAX_DENIALS + 3 }, () => gate("claude", work(s, "t1")));
    assert.deepEqual(outs.map((o) => o !== ""), [true, true, false, false, false]);
    await prompt(s, "t2", "now add a second fixture for the retry path in the python client tests");
    assert.notEqual(gate("claude", work(s, "t2")), "", "a new task turn is gated again");
});
test("a search in an earlier turn doesn't excuse a later task turn", async () => {
    const s = session();
    await prompt(s, "t1", task);
    await toolEvent("claude", JSON.stringify({ session_id: s, prompt_id: "t1", tool_name: "mcp__skillrouter__search_skills", tool_input: { query: "x" }, tool_use_id: "e1" }), false);
    assert.equal(gate("claude", work(s, "t1")), "");
    await new Promise((r) => setTimeout(r, 5));
    await prompt(s, "t2", "now add a second fixture for the retry path in the python client tests");
    assert.notEqual(gate("claude", work(s, "t2")), "", "the new turn must search for itself");
});
test("Cursor's shell hook sends a bare command, Gemini and Codex use their own session fields", async () => {
    const c = session();
    await prompt(c, "g1", task, "cursor");
    assert.notEqual(gate("cursor", { conversation_id: c, generation_id: "g1", command: "pytest -q", cwd: "/repo" }), "");
    assert.equal(gate("cursor", { conversation_id: c, generation_id: "g1", command: "ls src" }), "", "a read-only command");
    const g = session();
    await prompt(g, "", task, "gemini");
    const out = JSON.parse(gate("gemini", { session_id: g, tool_name: "run_shell_command", tool_input: { command: "npm test" } }));
    assert.equal(out.decision, "deny");
    const x = session();
    await prompt(x, "turn-9", task, "codex");
    assert.notEqual(gate("codex", { session_id: x, turn_id: "turn-9", tool_name: "Bash", tool_input: { command: "pytest" } }), "");
});
test("SKILLROUTER_GATE=0 turns it off, and bad input never throws", async () => {
    const s = session();
    await prompt(s, "t1", task);
    process.env.SKILLROUTER_GATE = "0";
    try {
        assert.equal(gate("claude", work(s, "t1")), "");
    }
    finally {
        delete process.env.SKILLROUTER_GATE;
    }
    for (const bad of ["", "not json", "null", "[]", '{"tool_name":5}', '{"session_id":"x","tool_name":"Bash","tool_input":null}'])
        assert.equal(gateEvent("claude", bad), "", bad);
});
const { install, CLAUDE_GATE_MATCHER, CODEX_GATE_MATCHER, CURSOR_GATE_MATCHER, GEMINI_GATE_MATCHER, CLAUDE_TOOL_MATCHER, CODEX_TOOL_MATCHER, CURSOR_TOOL_MATCHER, GEMINI_TOOL_MATCHER } = await import("../src/install.js");
const { health } = await import("../src/health.js");
const { fileURLToPath } = await import("node:url");
test("install adds the gate hook for each host, once, next to unrelated hooks, and only on work tools", () => {
    const h = fs.mkdtempSync(path.join(os.tmpdir(), "sr-gate-inst-"));
    fs.mkdirSync(path.join(h, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(h, ".claude", "settings.json"), JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo mine" }] }] } }));
    for (let i = 0; i < 2; i++)
        for (const a of ["claude", "codex", "cursor", "gemini"])
            install(a, h);
    const read = (...p) => JSON.parse(fs.readFileSync(path.join(h, ...p), "utf8")).hooks;
    const claude = read(".claude", "settings.json").PreToolUse;
    assert.equal(claude.length, 2, "the user's own PreToolUse hook is kept, ours added once");
    assert.equal(claude[0].hooks[0].command, "echo mine");
    assert.match(claude[1].hooks[0].command, /skillrouter-hint(?:\.mjs)?['"] claude gate$/);
    assert.equal(claude[1].matcher, CLAUDE_GATE_MATCHER);
    const codex = read(".codex", "hooks.json").PreToolUse;
    assert.equal(codex.length, 1);
    assert.equal(codex[0].matcher, CODEX_GATE_MATCHER);
    assert.match(codex[0].hooks[0].command, / codex gate$/);
    const cursor = read(".cursor", "hooks.json").preToolUse;
    assert.equal(cursor.length, 1);
    assert.equal(cursor[0].matcher, CURSOR_GATE_MATCHER);
    assert.match(cursor[0].command, / cursor gate$/);
    const gemini = read(".gemini", "settings.json").BeforeTool;
    assert.equal(gemini.length, 1);
    assert.equal(gemini[0].matcher, GEMINI_GATE_MATCHER);
    assert.equal(gemini[0].hooks[0].timeout, 5000, "Gemini counts milliseconds");
    // Never a read, a search or an MCP call: those would pay a process start for nothing.
    for (const [tool, m] of [["Read", CLAUDE_GATE_MATCHER], ["mcp__skillrouter__search_skills", CLAUDE_GATE_MATCHER], ["mcp__skillrouter__read_skill", CODEX_GATE_MATCHER], ["Read", CURSOR_GATE_MATCHER], ["read_file", GEMINI_GATE_MATCHER], ["activate_skill", GEMINI_GATE_MATCHER]])
        assert.ok(!new RegExp(`^(?:${m})$`).test(tool), `${tool} is not gated by ${m}`);
    for (const [tool, m] of [["Edit", CLAUDE_GATE_MATCHER], ["PowerShell", CLAUDE_GATE_MATCHER], ["apply_patch", CODEX_GATE_MATCHER], ["Bash", CODEX_GATE_MATCHER], ["Shell", CURSOR_GATE_MATCHER], ["run_shell_command", GEMINI_GATE_MATCHER]])
        assert.ok(new RegExp(`^(?:${m})$`).test(tool), `${tool} is gated by ${m}`);
    assert.match(health(h).join("\n"), /claude: .*search gate configured/);
});
test("the post-tool hooks see the router's search_skills under every host's naming, so a search counts for the gate", () => {
    const seen = (m, tool) => new RegExp(`^(?:${m})$`).test(tool);
    assert.ok(seen(CLAUDE_TOOL_MATCHER, "mcp__skillrouter__search_skills") && seen(CLAUDE_TOOL_MATCHER, "mcp__plugin_skillrouter_skillrouter__search_skills"));
    assert.ok(seen(CODEX_TOOL_MATCHER, "mcp__skillrouter__search_skills"));
    assert.ok(seen(CURSOR_TOOL_MATCHER, "MCP:search_skills"));
    assert.ok(seen(GEMINI_TOOL_MATCHER, "mcp_skillrouter_search_skills"));
    assert.ok(!seen(CLAUDE_TOOL_MATCHER, "mcp__other__search_skills_elsewhere"));
    const plugin = JSON.parse(fs.readFileSync(fileURLToPath(new URL("../../hooks/hooks.json", import.meta.url)), "utf8")).hooks;
    assert.equal(plugin.PostToolUse[0].matcher, CLAUDE_TOOL_MATCHER, "the plugin and the installer watch the same tools");
    assert.equal(plugin.PreToolUse[0].matcher, CLAUDE_GATE_MATCHER, "and gate the same ones");
    assert.match(plugin.PreToolUse[0].hooks[0].command, /hint claude gate$/);
});
test("the CLI's gate mode and the service protocol carry the same answer as the library call", async () => {
    const { spawnSync } = await import("node:child_process");
    const { ask } = await import("../src/service-client.js");
    const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
    const s = session();
    await prompt(s, "t1", task);
    const body = JSON.stringify(work(s, "t1"));
    const run = spawnSync(process.execPath, [cli, "hint", "claude", "gate"], { input: body, encoding: "utf8", env: { ...process.env, SKILLROUTER_SERVICE: "0" } });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(JSON.parse(run.stdout).hookSpecificOutput.permissionDecision, "deny");
    const ok = spawnSync(process.execPath, [cli, "hint", "claude", "gate"], { input: JSON.stringify({ session_id: s, prompt_id: "t1", tool_name: "Read", tool_input: { file_path: "/a" } }), encoding: "utf8", env: { ...process.env, SKILLROUTER_SERVICE: "0" } });
    assert.equal(ok.status, 0);
    assert.equal(ok.stdout.trim(), "", "allowed: no output at all, which every host reads as 'no objection'");
    // 'gate' is a mode the service serves: with nothing listening the answer is "failed" (start one), not "declined" (not a request it serves).
    assert.equal((await ask("claude", "gate", body, 300, "/nonexistent/svc.sock")).kind, "failed");
});
