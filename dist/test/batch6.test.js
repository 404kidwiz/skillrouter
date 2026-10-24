// Regression tests for the cross-host batch: Codex, Cursor, Gemini CLI and OpenCode triggers and end-of-turn checks.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
const home = fs.mkdtempSync(path.join(os.tmpdir(), "skillrouter-batch6-"));
process.env.HOME = home;
process.env.USERPROFILE = home; // Windows reads this, not HOME, for os.homedir()
process.env.SKILLROUTER_HOME = path.join(home, ".skillrouter");
fs.mkdirSync(process.env.SKILLROUTER_HOME, { recursive: true });
const { actionOf, matchTriggers, patchFiles } = await import("../src/triggers.js");
const { toolEvent, stopEvent, skillLoadOf, skillReadIn } = await import("../src/events.js");
const { formatHint, hint, isSystemText, sessionHash } = await import("../src/hint.js");
const { addShown, addTool, markTurn, turnStats, loadedSkills } = await import("../src/state.js");
const { install, addHook, openCodePlugin, CODEX_TOOL_MATCHER, CURSOR_TOOL_MATCHER, GEMINI_TOOL_MATCHER } = await import("../src/install.js");
const { saveIndex } = await import("../src/index.js");
const { tokenize } = await import("../src/bm25.js");
process.on("exit", () => fs.rmSync(home, { recursive: true, force: true }));
saveIndex({ builtAt: "x", roots: [], tokenizer: 2, skills: [
        { id: "python-testing", name: "python-testing", description: "Python testing with pytest fixtures and mocking for tests", path: "/s", root: "/s", tokens: tokenize("python testing pytest tests ".repeat(3)) },
    ] });
const ids = (tool, input) => { const a = actionOf(tool, input); return a ? matchTriggers(a).map((m) => m.trigger.id) : []; };
test("each host's edit and shell tools map to actions", () => {
    const patch = "*** Begin Patch\n*** Add File: tests/test_api.py\n+x\n*** Update File: Dockerfile\n@@\n-a\n+b\n*** End Patch";
    assert.deepEqual(patchFiles(patch), ["tests/test_api.py", "Dockerfile"]);
    assert.deepEqual(ids("apply_patch", { command: patch }), ["tests", "docker"], "Codex: one patch, two kinds of work");
    assert.deepEqual(ids("ApplyPatch", patch), ["tests", "docker"], "Cursor sends the patch as a string");
    assert.deepEqual(ids("patch", { patchText: patch }), ["tests", "docker"], "OpenCode");
    assert.deepEqual(ids("StrReplace", { path: "/r/web/Button.tsx", old_string: "a", new_string: "b" }), ["frontend"]);
    assert.deepEqual(ids("Write", { path: "/r/.github/workflows/ci.yml", contents: "" }), ["ci"]);
    assert.deepEqual(ids("write_file", { file_path: "/r/migrations/001.sql", content: "" }), ["migration"]);
    assert.deepEqual(ids("replace", { file_path: "/r/main.tf", old_string: "a", new_string: "b" }), ["terraform"]);
    assert.deepEqual(ids("edit", { filePath: "/r/src/auth/session.ts" }), ["auth"]);
    for (const [tool, input] of [["Shell", { command: "pnpm test" }], ["run_shell_command", { command: "pytest -q" }], ["bash", { command: "go test ./..." }], ["Bash", { command: "npx vitest run" }]])
        assert.deepEqual(ids(tool, input), ["tests"], tool);
    assert.equal(actionOf("apply_patch", { command: "no files here" }), null);
    assert.equal(actionOf("Read", { path: "/r/tests/a.py" }), null, "reads are not work");
});
test("skill loads are recognized under every host's naming", () => {
    const cases = [
        ["Skill", { skill: "pdf" }, "pdf"],
        ["mcp__skillrouter__read_skill", { id: "python-testing" }, "python-testing"],
        ["mcp__plugin_skillrouter_skillrouter__read_skill", { id: "a" }, "a"],
        ["mcp_skillrouter_read_skill", { id: "b" }, "b"],
        ["MCP:read_skill", { id: "c" }, "c"],
        ["skillrouter_read_skill", { id: "d" }, "d"],
        ["activate_skill", { name: "e" }, "e"],
        ["skill", { name: "f" }, "f"],
        ["CallDynamicTool", { namespace: "skillrouter", toolName: "read_skill", arguments: { id: "g" } }, "g"],
        ["CallDynamicTool", { toolName: "read_skill", arguments: { id: "g" } }, null],
        ["ReadFile", { path: "/Users/x/.skill-library/postgres-optimization/SKILL.md" }, "postgres-optimization"],
        ["Bash", { command: "cat ~/.agents/skills/writing-plans/SKILL.md" }, "writing-plans"],
        ["Shell", { command: "sed -n 1,80p /x/skills/impeccable/SKILL.md" }, "impeccable"],
        ["Bash", { command: "ls ~/.skills/*/SKILL.md" }, null],
        ["Bash", { command: "grep -l pytest ~/.skills/python-testing/SKILL.md" }, null],
        ["Write", { path: "/x/skills/new/SKILL.md", contents: "" }, null],
        ["Read", { path: "/r/src/app.ts" }, null],
    ];
    for (const [tool, input, skill] of cases)
        assert.equal(skillLoadOf(tool, input)?.skill ?? null, skill, tool);
});
test("Codex: tool hook claims rules, counts work per turn, drops tool output from the worker job", async () => {
    const S = sessionHash("C1"), T = sessionHash("turn-1");
    markTurn(S, T);
    const ev = (tool_name, tool_input) => JSON.stringify({ session_id: "C1", turn_id: "turn-1", cwd: "/repo", tool_name, tool_input, tool_response: "x".repeat(100) });
    const job = await toolEvent("codex", ev("apply_patch", { command: "*** Begin Patch\n*** Add File: /repo/tests/test_a.py\n+x\n*** End Patch" }), false);
    const spawned = JSON.parse(job.spawn);
    assert.deepEqual(spawned._claimed, ["tests"]);
    assert.equal(spawned.tool_response, undefined);
    assert.equal(await toolEvent("codex", ev("Bash", { command: "ls" }), false), "");
    assert.equal(turnStats(S, T).tools, 1, "the patch is work; `ls` is only looking around");
    assert.equal(await toolEvent("codex", ev("mcp__skillrouter__read_skill", { id: "python-testing", hint_id: "h" }), false), "");
    assert.ok(loadedSkills(S).has("python-testing"));
    assert.equal(turnStats(S, T).tools, 1, "a skill load is not counted as work");
});
const rollout = (msgs) => {
    const f = path.join(home, `rollout-${Math.random()}.jsonl`);
    fs.writeFileSync(f, msgs.map(([turn_id, text]) => JSON.stringify({ timestamp: new Date().toISOString(), type: "response_item",
        payload: { type: "message", role: "assistant", content: [{ type: "output_text", text }], internal_chat_message_metadata_passthrough: { turn_id } } })).join("\n") + "\n");
    return f;
};
test("Codex Stop: nudges once with block, reads the whole turn's text, respects stop_hook_active", () => {
    const S = sessionHash("C2"), T = sessionHash("t2");
    markTurn(S, T);
    addShown(S, ["python-testing"], T);
    for (let i = 0; i < 3; i++)
        addTool(S, T);
    addTool(S, sessionHash("other-turn")); // another turn's work never counts
    const stop = (extra) => stopEvent("codex", JSON.stringify({ session_id: "C2", turn_id: "t2", ...extra }));
    const bare = rollout([["t1", "Skills: none (earlier turn)"], ["t2", "Looking at the tests."], ["t2", "Done, tests pass."]]);
    const out = JSON.parse(stop({ transcript_path: bare, last_assistant_message: "Done, tests pass." }));
    assert.equal(out.decision, "block", "another turn's Skills: line doesn't count");
    assert.match(out.reason, /python-testing/);
    const early = rollout([["t2", "Skills: none (fixtures only)"], ["t2", "Done, tests pass."]]);
    assert.equal(stop({ transcript_path: early, last_assistant_message: "Done, tests pass." }), "", "the decision written before the work counts");
    assert.equal(stop({ transcript_path: bare, last_assistant_message: "Done.\nSkills: none (no skill fits)" }), "");
    assert.equal(stop({ transcript_path: bare, last_assistant_message: "Done.", stop_hook_active: true }), "");
    assert.equal(stop({ transcript_path: "/nonexistent", last_assistant_message: "Done." }), "", "unreadable transcript: no nudge");
    assert.equal(stopEvent("codex", JSON.stringify({ session_id: "C2", turn_id: "t-unseen", transcript_path: bare, last_assistant_message: "x" })), "", "no checks for that turn");
});
test("Codex Stop: fewer than 3 work calls is not nudged", () => {
    const S = sessionHash("C3"), T = sessionHash("t3");
    markTurn(S, T);
    addShown(S, ["python-testing"], T);
    addTool(S, T);
    addTool(S, T);
    assert.equal(stopEvent("codex", JSON.stringify({ session_id: "C3", turn_id: "t3", last_assistant_message: "ok" })), "");
});
const transcript = (lines) => { const f = path.join(home, `cursor-${Math.random()}.jsonl`); fs.writeFileSync(f, lines.map((l) => JSON.stringify(l)).join("\n") + "\n"); return f; };
const user = (text) => ({ role: "user", message: { content: [{ type: "text", text }] } });
const said = (text) => ({ role: "assistant", message: { content: [{ type: "text", text }] } });
const used = (name, input = {}) => ({ role: "assistant", message: { content: [{ type: "tool_use", name, input }] } });
test("Cursor stop: reads its role-based transcript, answers with followup_message, honors loop_count and status", () => {
    const S = sessionHash("conv-1"), G = sessionHash("gen-1");
    markTurn(S, G);
    addShown(S, ["python-testing"], G);
    const work = transcript([user("old turn"), said("Skills: none (old)"), user("<user_query>fix the tests</user_query>"), used("StrReplace", { path: "a" }), used("Shell", { command: "pytest" }), used("Shell", { command: "pytest" }), said("Fixed.")]);
    const stop = (extra) => stopEvent("cursor", JSON.stringify({ conversation_id: "conv-1", generation_id: "gen-1", status: "completed", loop_count: 0, transcript_path: work, ...extra }));
    assert.match(JSON.parse(stop({})).followup_message, /^skillrouter: /);
    assert.equal(stop({ loop_count: 1 }), "");
    assert.equal(stop({ status: "aborted" }), "");
    assert.equal(stop({ transcript_path: null }), "", "no transcript: a written decision can't be seen, so no nudge");
    const decided = transcript([user("fix the tests"), used("Shell"), used("Shell"), used("Shell"), said("Fixed.\n\nSkills: none (routine fix)")]);
    assert.equal(stop({ transcript_path: decided }), "");
    const loaded = transcript([user("fix the tests"), used("ReadFile", { path: "/u/.agents/skills/python-testing/SKILL.md" }), used("Shell"), used("Shell"), said("Fixed.")]);
    assert.equal(stop({ transcript_path: loaded }), "", "a SKILL.md read in the transcript is a load");
    const readOnly = transcript([user("explain the tests"), used("Grep", { pattern: "x", path: "." }), used("ReadFile", { path: "a" }), used("ReadFile", { path: "b" }), said("They check x.")]);
    assert.equal(stop({ transcript_path: readOnly }), "", "reading is not work: no visible follow-up");
    const unflushed = transcript([user("fix the tests"), used("StrReplace", { path: "a" }), used("Shell", { command: "pytest" }), used("Shell", { command: "pytest" })]);
    assert.equal(stop({ transcript_path: unflushed }), "", "final text not in the transcript yet");
    assert.equal(stop({ status: "error" }), "");
    const mcp = transcript([user("fix the tests"), used("CallMcpTool", { server: "skillrouter", toolName: "read_skill", arguments: JSON.stringify({ id: "python-testing" }) }), used("Shell", { command: "a" }), used("Shell", { command: "b" }), used("Shell", { command: "c" }), said("Fixed.")]);
    assert.equal(stop({ transcript_path: mcp }), "", "a read_skill inside Cursor's MCP wrapper is a load");
});
test("Cursor: the resubmitted nudge is a system turn, and conversation_id is the session", async () => {
    assert.equal(isSystemText("skillrouter: this turn did real work and skill checks were shown"), true);
    assert.equal(isSystemText("skillrouter: fix the flaky test in batch5"), false, "a real prompt about this repo still gets checked");
    await hint("cursor", JSON.stringify({ conversation_id: "conv-9", generation_id: "gen-9", prompt: "please write pytest fixtures for the api client tests" }));
    assert.ok(turnStats(sessionHash("conv-9"), sessionHash("gen-9")).start, "the prompt hook marked the turn under conversation_id");
});
test("Gemini AfterAgent: counts work since the prompt mark, denies with a retry prompt, reads prompt_response", async () => {
    const S = sessionHash("G1");
    markTurn(S);
    addShown(S, ["python-testing"]);
    for (let i = 0; i < 3; i++)
        addTool(S);
    const stop = (extra) => stopEvent("gemini", JSON.stringify({ session_id: "G1", prompt: "fix tests", ...extra }));
    const out = JSON.parse(stop({ prompt_response: "All green." }));
    assert.equal(out.decision, "deny");
    assert.match(out.reason, /final answer again/);
    assert.equal(stop({ prompt_response: "All green. Skills: python-testing" }), "");
    assert.equal(stop({ prompt_response: "x", stop_hook_active: true }), "");
    await new Promise((r) => setTimeout(r, 5)); // state rows are millisecond-stamped; a real next prompt is never in the same ms
    markTurn(S); // a new prompt resets the count and its checks
    assert.equal(stop({ prompt_response: "ok" }), "");
});
test("tool-event answers use each host's shape", () => {
    assert.deepEqual(JSON.parse(formatHint("gemini", "x", true)), { hookSpecificOutput: { hookEventName: "AfterTool", additionalContext: "x" } });
    assert.deepEqual(JSON.parse(formatHint("codex", "x", true)), { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: "x" } });
    assert.deepEqual(JSON.parse(formatHint("cursor", "x", true)), { additional_context: "x" });
    assert.deepEqual(JSON.parse(formatHint("cursor", "x")), { continue: true, additional_context: "x" });
    assert.deepEqual(JSON.parse(formatHint("gemini", "x")).hookSpecificOutput.hookEventName, "BeforeAgent");
});
test("install wires tool and end-of-turn hooks per host, idempotently, keeping unrelated hooks", () => {
    const h = path.join(home, "inst");
    fs.mkdirSync(path.join(h, ".cursor"), { recursive: true });
    fs.writeFileSync(path.join(h, ".cursor", "hooks.json"), JSON.stringify({ version: 1, hooks: { stop: [{ command: "say done" }] } }));
    for (let i = 0; i < 2; i++)
        for (const a of ["codex", "cursor", "gemini", "opencode"])
            install(a, h);
    const codex = JSON.parse(fs.readFileSync(path.join(h, ".codex", "hooks.json"), "utf8")).hooks;
    assert.deepEqual(Object.keys(codex).sort(), ["PostToolUse", "Stop", "UserPromptSubmit"]);
    assert.equal(codex.PostToolUse.length, 1);
    assert.equal(codex.PostToolUse[0].matcher, CODEX_TOOL_MATCHER);
    assert.match(codex.Stop[0].hooks[0].command, /skillrouter-hint(?:\.mjs)?['"] codex stop$/);
    const cursor = JSON.parse(fs.readFileSync(path.join(h, ".cursor", "hooks.json"), "utf8")).hooks;
    assert.equal(cursor.postToolUse.length, 1);
    assert.equal(cursor.postToolUse[0].matcher, CURSOR_TOOL_MATCHER);
    assert.deepEqual(cursor.stop.map((x) => x.command.split(" ").pop()), ["done", "stop"], "unrelated stop hook kept");
    const gemini = JSON.parse(fs.readFileSync(path.join(h, ".gemini", "settings.json"), "utf8")).hooks;
    assert.equal(gemini.AfterTool[0].matcher, GEMINI_TOOL_MATCHER);
    assert.equal(gemini.AfterAgent.length, 1);
    assert.match(fs.readFileSync(path.join(h, ".config", "opencode", "plugins", "skillrouter-hints.js"), "utf8"), /'tool\.execute\.after'/);
    for (const m of [CODEX_TOOL_MATCHER, CURSOR_TOOL_MATCHER, GEMINI_TOOL_MATCHER])
        assert.doesNotThrow(() => new RegExp(m));
});
test("OpenCode plugin: work tools get the trigger appended to their output; other tools spawn nothing", async () => {
    const seen = path.join(home, "oc-seen.jsonl");
    const stub = path.join(home, "oc-stub.cjs");
    fs.writeFileSync(stub, `let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{require('fs').appendFileSync(${JSON.stringify(seen)}, JSON.stringify({argv:process.argv.slice(2),input:JSON.parse(s)})+'\\n');process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'PostToolUse',additionalContext:'TRIGGER'}}));});`);
    const file = path.join(home, "oc-plugin.mjs");
    fs.writeFileSync(file, openCodePlugin(process.execPath, [stub, "opencode"], 2000));
    const { SkillrouterHints } = await import(pathToFileURL(file).href);
    const hooks = await SkillrouterHints({ directory: "/repo" });
    const out = { title: "", output: "edited", metadata: {} };
    await hooks["tool.execute.after"]({ tool: "edit", sessionID: "ses", callID: "c", args: { filePath: "/repo/tests/a.test.ts" } }, out);
    assert.equal(out.output, "edited\n\nTRIGGER");
    const quiet = { title: "", output: "read", metadata: {} };
    await hooks["tool.execute.after"]({ tool: "read", sessionID: "ses", callID: "d", args: { filePath: "/repo/x" } }, quiet);
    assert.equal(quiet.output, "read");
    const calls = fs.readFileSync(seen, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].argv, ["opencode", "tool"]);
    assert.deepEqual(calls[0].input, { session_id: "ses", tool_use_id: "c", tool_name: "edit", tool_input: { filePath: "/repo/tests/a.test.ts" }, cwd: "/repo" });
});
test("shell reads of a SKILL.md: what counts as a load and what doesn't", () => {
    const yes = [
        ["cat ~/.agents/skills/writing-plans/SKILL.md", "writing-plans"],
        ["/bin/cat /x/skills/a-b/SKILL.md", "a-b"],
        ["head -n 80 '/x/.skill-library/pdf/SKILL.md' 2>/dev/null", "pdf"],
        ["cd /repo && sed -n 1,120p /x/skills/impeccable/SKILL.md", "impeccable"],
    ];
    for (const [c, s] of yes)
        assert.equal(skillReadIn(c), s, c);
    for (const c of ["cat > skills/new/SKILL.md <<EOF\nx\nEOF", "grep -n x skills/a/SKILL.md | head -20", "git log -p -- skills/a/SKILL.md | head",
        "ls skills/a/SKILL.md && cat package.json", "cat ./SKILL.md", "cat skills/a/SKILL.md.bak", "sed -i s/a/b/ skills/a/SKILL.md", "cat skills/a/SKILL.md | tee skills/b/SKILL.md", "cat ~/.skills/*/SKILL.md"])
        assert.equal(skillReadIn(c), null, c);
    assert.equal(skillLoadOf("Bash", { command: 'bash -lc "sed -n 1,80p /x/skills/tdd/SKILL.md"' })?.skill, "tdd", "Codex wraps scripts in bash -lc");
    assert.equal(skillLoadOf("Bash", { command: ["zsh", "-lc", "cat /x/skills/tdd/SKILL.md"] })?.skill, "tdd", "argv form");
    assert.equal(skillLoadOf("MCP:read_skill", '{"id":"x"}')?.skill, "x", "tool_input as a JSON string");
    assert.equal(skillLoadOf("mcp__openspace__read_skill", { id: "x" }), null, "another server's read_skill");
    assert.deepEqual(actionOf("Bash", { command: 'bash -lc "pytest -q"' }) && matchTriggers(actionOf("Bash", { command: 'bash -lc "pytest -q"' })).map((m) => m.trigger.id), ["tests"]);
});
test("Cursor tool events without cwd use workspace_roots, so folders above the repo don't trigger", async () => {
    const ev = { conversation_id: "conv-cwd", generation_id: "g", tool_name: "Write", tool_input: { file_path: "/Users/x/auth-service/README.md" }, workspace_roots: ["/Users/x/auth-service"] };
    assert.equal(await toolEvent("cursor", JSON.stringify(ev), false), "");
});
test("reinstall keeps the router hook's position among the user's hooks", () => {
    const d = { hooks: { Stop: [{ hooks: [{ type: "command", command: "'/h/.skillrouter/bin/skillrouter-hint' codex stop" }] }, { hooks: [{ type: "command", command: "my-own-hook" }] }] } };
    addHook(d, "Stop", { hooks: [{ type: "command", command: "'/h/.skillrouter/bin/skillrouter-hint' codex stop" }] });
    assert.deepEqual(d.hooks.Stop.map((e) => e.hooks[0].command.split(" ").pop()), ["stop", "my-own-hook"]);
    const cursor = JSON.parse(fs.readFileSync(path.join(home, "inst", ".cursor", "hooks.json"), "utf8")).hooks;
    assert.equal(cursor.stop.find((x) => /skillrouter/.test(x.command)).loop_limit, 1);
});
test("second QA pass: Codex transcript coverage, read-only turns, unwrap safety, load plus work", async () => {
    const { isWork, shellCommand } = await import("../src/triggers.js");
    const { codexTurnTexts } = await import("../src/events.js");
    // A turn whose start fell out of the 4 MB tail can't be judged; neither can an unrecognized transcript.
    const f = path.join(home, "long-rollout.jsonl");
    const msg = (text) => JSON.stringify({ timestamp: new Date().toISOString(), type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text }], internal_chat_message_metadata_passthrough: { turn_id: "T" } } });
    fs.writeFileSync(f, [msg("Skills: none (x)"), ...Array.from({ length: 5 }, () => JSON.stringify({ timestamp: new Date().toISOString(), type: "response_item", payload: { type: "function_call_output", output: "y".repeat(1024 * 1024) } })), msg("Done.")].join("\n") + "\n");
    assert.equal(codexTurnTexts(f, "T", Date.now() - 60_000), null, "start of turn out of reach");
    const junk = path.join(home, "junk.jsonl");
    fs.writeFileSync(junk, "not json\n{}\n");
    assert.equal(codexTurnTexts(junk, "T", 0), null, "nothing recognized");
    const small = path.join(home, "small.jsonl");
    fs.writeFileSync(small, msg("Skills: none (y)") + "\n");
    assert.deepEqual(codexTurnTexts(small, "", Date.now() - 60_000), ["Skills: none (y)"], "no turn id: by time");
    // Exploration through the shell is not work; edits and real commands are.
    for (const c of ["ls -la", "rg -n foo src", "git status && git log -5", "cat a | head", "sed -n 1,20p x", "find . -name '*.ts'"])
        assert.equal(isWork(actionOf("Bash", { command: c })), false, c);
    for (const c of ["pytest -q", "ls && pnpm build", "echo x > out.txt", "find . -name x -delete", "git commit -m x"])
        assert.equal(isWork(actionOf("Bash", { command: c })), true, c);
    assert.equal(isWork(actionOf("Write", { path: "a" })), true);
    // Unwrapping stays linear on hostile input and leaves compound commands alone.
    const t0 = Date.now();
    shellCommand({ command: "bash -" + "x".repeat(32_000) + " 'y'" });
    shellCommand({ command: ["bash", "-" + "x".repeat(32_000), "y"] });
    assert.ok(Date.now() - t0 < 200, `unwrap took ${Date.now() - t0} ms`);
    assert.deepEqual(matchTriggers(actionOf("Bash", { command: 'bash -c "echo a" && pytest "x"' })).map((m) => m.trigger.id), ["tests"]);
    // A load and work in one command: the load is recorded and the trigger still fires.
    const job = await toolEvent("codex", JSON.stringify({ session_id: "LW", turn_id: "lw", cwd: "/repo", tool_name: "Bash", tool_input: { command: "cat /x/skills/python-testing/SKILL.md && pytest" } }), false);
    assert.deepEqual(JSON.parse(job.spawn)._claimed, ["tests"]);
    assert.ok(loadedSkills(sessionHash("LW")).has("python-testing"));
    assert.equal(skillReadIn("(cat /x/skills/tee-time/SKILL.md)"), "tee-time", "tee only as a command, not in a skill name; subshell parens");
});
test("Cursor and Codex: a read-only shell turn is not nudged", () => {
    const S = sessionHash("conv-ro"), G = sessionHash("gen-ro");
    markTurn(S, G);
    addShown(S, ["python-testing"], G);
    const ro = transcript([user("where is x?"), used("Shell", { command: "rg -n x" }), used("Shell", { command: "ls" }), used("Shell", { command: "git log -3" }), said("It is in a.ts.")]);
    assert.equal(stopEvent("cursor", JSON.stringify({ conversation_id: "conv-ro", generation_id: "gen-ro", status: "completed", loop_count: 0, transcript_path: ro })), "");
});
