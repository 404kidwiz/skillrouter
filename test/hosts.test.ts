import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "skillrouter-hosts-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.SKILLROUTER_HOME = path.join(home, ".skillrouter");
process.env.SKILLROUTER_SERVICE = "0";
delete process.env.SKILLROUTER_GATE;
process.on("exit", () => fs.rmSync(home, { recursive: true, force: true }));

const { buildIndexFrom, saveIndex } = await import("../src/index.js");
const { resetIndexCache } = await import("../src/search.js");
const { fromHost, silent } = await import("../src/hosts.js");
const { hint, formatHint } = await import("../src/hint.js");
const { gateEvent, formatGate } = await import("../src/gate.js");
const { install, HERMES_GATE_MATCHER, launcherScript } = await import("../src/install.js");
const { hostHooks } = await import("../src/health.js");
const { backupPlan, pruneBackups, formatBackups } = await import("../src/backups.js");
const { gapLines, readLog } = await import("../src/report.js");

const root = path.join(home, "skills");
function fixture(name: string, description: string) {
  const dir = path.join(root, name); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\nbody of ${name}\n`);
}
fixture("python-testing", "Write Python pytest tests with fixtures and mocks for regression coverage.");
for (let i = 0; i < 80; i++) fixture(`filler-${i}`, `Pottery kiln glaze clay wheel hobby ${i}`);
saveIndex(buildIndexFrom([root])); resetIndexCache();

const PROMPT = "write python pytest regression tests with fixtures and mocks for the parser";
const hermes = (event: string, session: string, extra: object, tool?: [string, object]) =>
  JSON.stringify({ hook_event_name: event, tool_name: tool?.[0] ?? null, tool_input: tool?.[1] ?? null, session_id: session, cwd: "/w", profile: "default", extra: { kanban_task_id: "", ...extra } });

test("Hermes payloads are read in Hermes's shape and answered in Hermes's shape", async () => {
  const out = JSON.parse(await hint("hermes", hermes("pre_llm_call", "h1", { turn_id: "t1", user_message: PROMPT, is_first_turn: true })));
  assert.match(out.context, /^Skill check \(skillrouter\)/);
  assert.match(out.context, /python-testing — not preloaded: read_skill\("python-testing"/, "nothing is preloaded on Hermes: every suggestion is a read");
  // A multimodal message is its text parts; no prompt at all is a quiet no-op.
  const parts = JSON.parse(await hint("hermes", hermes("pre_llm_call", "h2", { turn_id: "t1", user_message: [{ type: "text", text: PROMPT }, { type: "image_url", image_url: { url: "x" } }] })));
  assert.match(parts.context, /python-testing/);
  assert.equal(await hint("hermes", hermes("pre_llm_call", "h3", { turn_id: "t1" })), "{}");
  // The gate: the first work call of the task turn is refused until a search or a skill load, in Hermes's block shape.
  const call = (tool: [string, object], id: string) => gateEvent("hermes", hermes("pre_tool_call", "h1", { turn_id: "t1", tool_call_id: id }, tool));
  assert.equal(call(["terminal", { command: "ls -la" }], "c0"), "{}", "a read-only command is not work");
  assert.equal(call(["read_file", { path: "/w/a.py" }], "c0b"), "{}");
  const refused = JSON.parse(call(["terminal", { command: "npm install left-pad" }], "c1"));
  assert.equal(refused.decision, "block");
  assert.match(refused.reason, /search the skill library/);
  assert.equal(JSON.parse(call(["write_file", { path: "/w/a.py", content: "x" }], "c2")).decision, "block");
  assert.equal(call(["patch", { path: "/w/a.py", old_string: "a", new_string: "b" }], "c3"), "{}", "after two refusals the gate steps aside");
  // A V4A patch (files named in its text) and code execution are work too.
  await hint("hermes", hermes("pre_llm_call", "h6", { turn_id: "t1", user_message: PROMPT }));
  const call6 = (tool: [string, object], id: string) => gateEvent("hermes", hermes("pre_tool_call", "h6", { turn_id: "t1", tool_call_id: id }, tool));
  assert.equal(JSON.parse(call6(["patch", { mode: "patch", patch: "*** Begin Patch\n*** Update File: src/a.py\n@@\n-a\n+b\n*** End Patch" }], "p1")).decision, "block");
  assert.equal(JSON.parse(call6(["execute_code", { code: "open('x','w').write('y')" }], "p2")).decision, "block");
  // Another session: a search through the router's MCP tool (Hermes's naming) opens the gate at once; so does skill_view.
  await hint("hermes", hermes("pre_llm_call", "h4", { turn_id: "t9", user_message: PROMPT }));
  const call4 = (tool: [string, object], id: string) => gateEvent("hermes", hermes("pre_tool_call", "h4", { turn_id: "t9", tool_call_id: id }, tool));
  assert.equal(call4(["mcp_skillrouter_search_skills", { query: "pytest" }], "d1"), "{}");
  assert.equal(call4(["write_file", { path: "/w/a.py", content: "x" }], "d2"), "{}");
  await hint("hermes", hermes("pre_llm_call", "h5", { turn_id: "t1", user_message: PROMPT }));
  const call5 = (tool: [string, object], id: string) => gateEvent("hermes", hermes("pre_tool_call", "h5", { turn_id: "t1", tool_call_id: id }, tool));
  assert.equal(call5(["skill_view", { name: "python-testing" }], "e1"), "{}");
  assert.equal(call5(["terminal", { command: "npm test -- --update" }], "e2"), "{}");
  // The log names the host, and holds no prompt text.
  const rows = readLog(1).filter((r: any) => r.agent === "hermes");
  assert.ok(rows.some((r: any) => r.client === "hook/hermes" && r.tool === "hint" && r.reason === "shown"));
  assert.ok(rows.some((r: any) => r.tool === "gate" && r.reason === "denied"));
  assert.ok(!fs.readFileSync(path.join(process.env.SKILLROUTER_HOME!, "usage.jsonl"), "utf8").includes("parser"));
  // Switched off, garbage, and a payload already in the generic shape.
  assert.equal(gateEvent("hermes", hermes("pre_tool_call", "h9", { turn_id: "t1" }, ["terminal", { command: "rm -rf x" }]), false), "{}");
  assert.equal(gateEvent("hermes", "not json"), "{}");
  assert.equal(fromHost("hermes", JSON.stringify({ session_id: "s", prompt: "p" }), "prompt"), JSON.stringify({ session_id: "s", prompt: "p" }));
  assert.equal(fromHost("codex", "anything", "gate"), "anything");
});

test("Antigravity payloads: one check per user input, a decision on every tool call", async () => {
  const base = (conversationId: string, lastUserInput: string, more: object = {}) => JSON.stringify({ conversationId, workspacePaths: ["/w"], transcriptPath: "/t", modelName: "m", lastUserInput, ...more });
  const first = JSON.parse(await hint("antigravity", base("a1", PROMPT, { invocationNum: 0, initialNumSteps: 1 })));
  assert.match(first.injectSteps[0].ephemeralMessage, /^Skill check \(skillrouter\)/);
  assert.match(first.injectSteps[0].ephemeralMessage, /read_skill\("python-testing"/);
  // The hook runs before every model call: later calls of the same turn add nothing, a new input is a new turn.
  assert.equal(await hint("antigravity", base("a1", PROMPT, { invocationNum: 1 })), "{}");
  assert.equal(await hint("antigravity", base("a1", PROMPT, { invocationNum: 2 })), "{}");
  const tool = (conv: string, input: string, name: string, args: object, step: number) => JSON.parse(gateEvent("antigravity", base(conv, input, { stepIdx: step, toolCall: { name, args } })));
  assert.deepEqual(tool("a1", PROMPT, "view_file", { AbsolutePath: "/w/a.py" }, 1), { decision: "allow" });
  assert.deepEqual(tool("a1", PROMPT, "run_command", { CommandLine: "git status", Cwd: "/w" }, 2), { decision: "allow" });
  const denied = tool("a1", PROMPT, "run_command", { CommandLine: "npm install left-pad", Cwd: "/w" }, 3);
  assert.equal(denied.decision, "deny");
  assert.match(denied.reason, /search the skill library/);
  assert.equal(tool("a1", PROMPT, "write_to_file", { TargetFile: "/w/a.py", CodeContent: "x" }, 4).decision, "deny");
  assert.deepEqual(tool("a1", PROMPT, "replace_file_content", { TargetFile: "/w/a.py" }, 5), { decision: "allow" }, "after two refusals the gate steps aside");
  // A search under whatever name the app gives the router's MCP tool opens the gate.
  for (const [conv, name] of [["a2", "mcp_skillrouter_search_skills"], ["a3", "skillrouter/search_skills"], ["a4", "mcp__skillrouter__search_skills"], ["a5", "search_skills"], ["a51", "mcp0_search_skills"], ["a52", "mcp_SkillRouter_search_skills"], ["a53", "skillrouterSearchSkills"]]) {
    await hint("antigravity", base(conv, PROMPT, { invocationNum: 0 }));
    assert.deepEqual(tool(conv, PROMPT, name, { query: "pytest" }, 1), { decision: "allow" });
    assert.deepEqual(tool(conv, PROMPT, "run_command", { CommandLine: "npm install left-pad" }, 2), { decision: "allow" }, name);
  }
  // Another server's tool of that name is not the router's.
  await hint("antigravity", base("a6", PROMPT, { invocationNum: 0 }));
  assert.deepEqual(tool("a6", PROMPT, "mcp_other_search_skills", { query: "x" }, 1), { decision: "allow" });
  assert.equal(tool("a6", PROMPT, "run_command", { CommandLine: "npm install left-pad" }, 2).decision, "deny");
  // No prompt check ran for this input (hooks added mid-conversation, or the check failed): nothing is gated.
  assert.deepEqual(tool("a7", "some other long task description nobody checked", "run_command", { CommandLine: "npm install left-pad" }, 1), { decision: "allow" });
  // A new user input in the same conversation is a new turn and is checked again.
  const again = JSON.parse(await hint("antigravity", base("a1", PROMPT + " and the lexer", { invocationNum: 0 })));
  assert.ok(Array.isArray(again.injectSteps));
  // Always a decision: switched off, unreadable input, missing fields.
  assert.equal(gateEvent("antigravity", base("a1", PROMPT, { toolCall: { name: "run_command", args: { CommandLine: "rm -rf x" } } }), false), '{"decision":"allow"}');
  assert.equal(gateEvent("antigravity", "not json"), '{"decision":"allow"}');
  assert.equal(gateEvent("antigravity", "{}"), '{"decision":"allow"}');
  assert.equal(await hint("antigravity", "not json"), "{}");
});

test("each host gets its own wire shapes", () => {
  assert.deepEqual(JSON.parse(formatHint("hermes", "x")), { context: "x" });
  assert.equal(formatHint("hermes", ""), "{}");
  assert.deepEqual(JSON.parse(formatHint("antigravity", "x")), { injectSteps: [{ ephemeralMessage: "x" }] });
  assert.equal(formatHint("antigravity", ""), "{}");
  assert.deepEqual(JSON.parse(formatGate("hermes", "r")), { decision: "block", reason: "r" });
  assert.deepEqual(JSON.parse(formatGate("antigravity", "r")), { decision: "deny", reason: "r" });
  assert.equal(silent("antigravity", true), '{"decision":"allow"}');
  assert.equal(silent("antigravity", false), "{}");
  assert.equal(silent("hermes", true), "{}");
  assert.equal(silent("codex", true), "");
  // Existing hosts are unchanged.
  assert.equal(formatHint("codex", ""), "");
  assert.match(formatGate("claude", "r"), /permissionDecision/);
  const m = new RegExp(HERMES_GATE_MATCHER);
  for (const t of ["terminal", "write_file", "patch", "execute_code", "skill_view", "mcp_skillrouter_search_skills", "mcp_skillrouter_read_skill"]) assert.ok(m.test(t), t);
  for (const t of ["read_file", "web_search", "terminal_x", "xterminal", "mcp_other_search_skills"]) assert.ok(!m.test(t), t);
});

// A stand-in for Hermes's Python package: load_config/save_config over the file in HERMES_HOME, kept as JSON
// (valid YAML) so the test needs no YAML library. The real API was exercised against real configs by hand.
const python = ["python3", "python"].find((p) => spawnSync(p, ["-c", "import sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)"]).status === 0);
function fakeHermes(h: string, profiles: string[]) {
  const agent = path.join(h, ".hermes", "hermes-agent", "hermes_cli");
  fs.mkdirSync(agent, { recursive: true });
  fs.writeFileSync(path.join(agent, "__init__.py"), "");
  fs.writeFileSync(path.join(agent, "config.py"), `import json, os
def _p(): return os.path.join(os.environ["HERMES_HOME"], "config.yaml")
def load_config():
    with open(_p()) as f: return json.load(f)
def save_config(c):
    with open(_p(), "w") as f: json.dump(c, f, indent=2)
`);
  const write = (dir: string, c: object) => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, "config.yaml"), JSON.stringify(c)); };
  write(path.join(h, ".hermes"), { model: "x", mcp_servers: { other: { command: "/bin/other" }, skillrouter: { command: "/old/node", args: ["/old/cli.js", "mcp"], env: { KEEP: "1" }, enabled: false } },
    hooks: { pre_tool_call: [{ matcher: "terminal", command: "/mine/guard.sh" }, { matcher: "x", command: "'/old/.skillrouter/bin/skillrouter-hint' hermes gate" }], post_tool_call: [{ command: "/mine/format.sh" }] } });
  for (const p of profiles) write(path.join(h, ".hermes", "profiles", p), { model: p });
  fs.mkdirSync(path.join(h, ".hermes", "profiles", "empty"), { recursive: true }); // a folder without a config is not a profile
}
const read = (h: string, ...p: string[]) => JSON.parse(fs.readFileSync(path.join(h, ".hermes", ...p), "utf8"));

test("install hermes writes the MCP entry and both hooks into the main home and every profile, through Hermes's own API", { skip: !python }, () => {
  const h = path.join(home, "hermes-install");
  fakeHermes(h, ["captain", "scout"]);
  process.env.SKILLROUTER_HERMES_PYTHON = python!;
  try {
    const out = install("hermes", h).join("\n");
    assert.match(out, /set via Hermes config API for main, captain, scout/);
    assert.match(out, /Hermes runs a new hook only after you approve it/);
    assert.doesNotMatch(out, /FAILED/);
    const main = read(h, "config.yaml");
    // The MCP entry: command and args replaced, the user's other settings and other servers kept.
    assert.equal(main.mcp_servers.other.command, "/bin/other");
    assert.equal(main.mcp_servers.skillrouter.args.at(-1), "mcp");
    assert.notEqual(main.mcp_servers.skillrouter.command, "/old/node");
    assert.deepEqual(main.mcp_servers.skillrouter.env, { KEEP: "1", SKILLROUTER_AGENT: "hermes" });
    assert.equal(main.mcp_servers.skillrouter.enabled, false);
    // Hooks: the user's own stay, the router's old entry is replaced by one, the prompt check is added.
    assert.deepEqual(main.hooks.post_tool_call, [{ command: "/mine/format.sh" }]);
    assert.equal(main.hooks.pre_tool_call.length, 2);
    assert.deepEqual(main.hooks.pre_tool_call[0], { matcher: "terminal", command: "/mine/guard.sh" });
    assert.equal(main.hooks.pre_tool_call[1].matcher, HERMES_GATE_MATCHER);
    assert.match(main.hooks.pre_tool_call[1].command, /skillrouter-hint.* hermes gate$/);
    assert.ok(!main.hooks.pre_tool_call[1].command.includes("/old/"));
    assert.equal(main.hooks.pre_llm_call.length, 1);
    assert.match(main.hooks.pre_llm_call[0].command, /skillrouter-hint.* hermes$/);
    assert.equal(main.hooks.pre_llm_call[0].timeout, 5);
    for (const p of ["captain", "scout"]) {
      const c = read(h, "profiles", p, "config.yaml");
      assert.equal(c.model, p);
      assert.equal(c.mcp_servers.skillrouter.env.SKILLROUTER_AGENT, "hermes");
      assert.equal(c.hooks.pre_llm_call.length, 1);
      assert.equal(c.hooks.pre_tool_call.length, 1);
    }
    assert.ok(fs.existsSync(path.join(h, ".hermes", "config.yaml.bak-skillrouter")));
    assert.ok(fs.existsSync(path.join(h, ".skillrouter", "bin")), "the hook launcher is written for Hermes too");
    // No consent is recorded unless asked for; doctor says the hooks will not run yet.
    assert.ok(!fs.existsSync(path.join(h, ".hermes", "shell-hooks-allowlist.json")));
    assert.match(hostHooks("hermes", h), /NOT yet approved in Hermes/);
    // Again, now with consent: nothing is duplicated, and exactly our two hooks are approved in each home.
    fs.writeFileSync(path.join(h, ".hermes", "shell-hooks-allowlist.json"), JSON.stringify({ approvals: [{ event: "post_tool_call", command: "/mine/format.sh" }] }));
    const second = install("hermes", h, undefined, { acceptHooks: true }).join("\n");
    assert.match(second, /Hermes hooks approved for these homes/);
    const again = read(h, "config.yaml");
    assert.equal(again.hooks.pre_tool_call.length, 2);
    assert.equal(again.hooks.pre_llm_call.length, 1);
    const allow = read(h, "shell-hooks-allowlist.json").approvals;
    assert.equal(allow.length, 4);
    assert.deepEqual(allow[0], { event: "post_tool_call", command: "/mine/format.sh" });
    assert.deepEqual(allow.slice(1).map((a: any) => [a.event, a.command]), [["pre_llm_call", again.hooks.pre_llm_call[0].command], ["pre_tool_call", again.hooks.pre_tool_call[1].command], ["post_llm_call", again.hooks.post_llm_call[0].command]]);
    assert.match(again.hooks.post_llm_call[0].command, /skillrouter-hint.* hermes decision$/);
    assert.equal(again.hooks.post_llm_call.length, 1);
    assert.equal(read(h, "profiles", "scout", "shell-hooks-allowlist.json").approvals.length, 3);
    install("hermes", h, undefined, { acceptHooks: true });
    assert.equal(read(h, "shell-hooks-allowlist.json").approvals.length, 4, "approving twice adds nothing");
    assert.match(hostHooks("hermes", h), /approved in Hermes$/);
    // A user's own hook that wraps or mentions the launcher is theirs: it stays.
    const mine = read(h, "config.yaml");
    mine.hooks.pre_tool_call.unshift({ command: "/mine/audit.sh '/x/skillrouter-hint' hermes gate" }, { command: "echo skillrouter-hint hermes # note" });
    fs.writeFileSync(path.join(h, ".hermes", "config.yaml"), JSON.stringify(mine));
    install("hermes", h);
    assert.deepEqual(read(h, "config.yaml").hooks.pre_tool_call.map((e: any) => e.command).slice(0, 3), ["/mine/audit.sh '/x/skillrouter-hint' hermes gate", "echo skillrouter-hint hermes # note", "/mine/guard.sh"]);
    assert.equal(read(h, "config.yaml").hooks.pre_tool_call.length, 4);
    // Shapes the installer does not understand are left exactly as found, and named.
    const captain = path.join(h, ".hermes", "profiles", "captain", "config.yaml");
    for (const odd of [{ model: "c", hooks: ["a list"] }, { model: "c", hooks: { pre_tool_call: { command: "/mine/guard.sh" } } }, { model: "c", mcp_servers: "text" }]) {
      fs.writeFileSync(captain, JSON.stringify(odd));
      assert.match(install("hermes", h).join("\n"), /FAILED, not changed: captain \(left unchanged: /);
      assert.deepEqual(JSON.parse(fs.readFileSync(captain, "utf8")), odd);
    }
    fs.writeFileSync(captain, JSON.stringify({ model: "captain" }));
    // An allowlist that is not in Hermes's documented shape is not overwritten; a valid one is backed up before the first change.
    const allowFile = path.join(h, ".hermes", "profiles", "captain", "shell-hooks-allowlist.json");
    for (const bad of ["[1, 2]", "{ broken", JSON.stringify({ approvals: "x" })]) {
      fs.writeFileSync(allowFile, bad);
      assert.match(install("hermes", h, undefined, { acceptHooks: true }).join("\n"), /FAILED, not changed: captain \(left unchanged: shell-hooks-allowlist\.json/);
      assert.equal(fs.readFileSync(allowFile, "utf8"), bad);
      assert.equal(JSON.parse(fs.readFileSync(captain, "utf8")).hooks, undefined, "nothing is written to the config either");
    }
    fs.rmSync(allowFile);
    assert.ok(fs.existsSync(path.join(h, ".hermes", "shell-hooks-allowlist.json.bak-skillrouter")));
    // A module planted in a profile folder is never imported by the installer's Python.
    fs.writeFileSync(path.join(h, ".hermes", "profiles", "captain", "datetime.py"), "raise SystemExit('planted')\n");
    fs.writeFileSync(path.join(h, ".hermes", "profiles", "captain", "json.py"), "raise SystemExit('planted')\n");
    assert.doesNotMatch(install("hermes", h, undefined, { acceptHooks: true }).join("\n"), /planted|FAILED/);
    // A profile whose config Hermes cannot load is reported and left alone; the others are still done.
    fs.writeFileSync(path.join(h, ".hermes", "profiles", "scout", "config.yaml"), "{ not json");
    const third = install("hermes", h).join("\n");
    assert.match(third, /for main, captain; FAILED, not changed: scout \(/);
    assert.equal(fs.readFileSync(path.join(h, ".hermes", "profiles", "scout", "config.yaml"), "utf8"), "{ not json");
  } finally { delete process.env.SKILLROUTER_HERMES_PYTHON; }
});

test("without Hermes installed, or without its Python, install hermes says what it did not do", () => {
  const none = path.join(home, "no-hermes");
  assert.match(install("hermes", none).join("\n"), /missing \(Hermes not installed\); skipped/);
  assert.ok(!fs.existsSync(path.join(none, ".skillrouter")), "no launcher is written for a host that is not there");
  const h = path.join(home, "hermes-nopy");
  fs.mkdirSync(path.join(h, ".hermes"), { recursive: true }); fs.writeFileSync(path.join(h, ".hermes", "config.yaml"), "model: x\n");
  const out = install("hermes", h).join("\n");
  assert.match(out, /Hermes's Python not found/);
  assert.match(out, /Hermes hooks not installed/);
  assert.equal(fs.readFileSync(path.join(h, ".hermes", "config.yaml"), "utf8"), "model: x\n");
  assert.equal(hostHooks("hermes", h), "not installed (run `skillrouter install hermes`)");
  assert.equal(hostHooks("hermes", none), "missing");
  // The hook command as each OS writes it, in either quoting a YAML or JSON writer may choose.
  for (const line of [`- command: "'/Users/x/.skillrouter/bin/skillrouter-hint' hermes"`, `- command: 'node "C:/Users/x/.skillrouter/bin/skillrouter-hint.mjs" hermes gate'`, `"command": "node \\"C:/Users/x/.skillrouter/bin/skillrouter-hint.mjs\\" hermes"`]) {
    fs.writeFileSync(path.join(h, ".hermes", "config.yaml"), `hooks:\n  pre_llm_call:\n    ${line}\n`);
    assert.match(hostHooks("hermes", h), /^configured: .*NOT yet approved/, line);
  }
  fs.writeFileSync(path.join(h, ".hermes", "config.yaml"), "hooks:\n  pre_llm_call:\n    - command: /mine/skillrouter-hint-wrapper.sh hermesx\n");
  assert.match(hostHooks("hermes", h), /^not installed/);
});

test("Antigravity hooks are installed only when asked for, beside the user's own hook groups", () => {
  const h = path.join(home, "ag-install"), file = path.join(h, ".gemini", "config", "hooks.json");
  const plain = install("antigravity", h).join("\n");
  assert.match(plain, /available but experimental.*install antigravity --hooks/);
  assert.ok(!fs.existsSync(file));
  assert.match(hostHooks("antigravity", h), /^not installed/);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ "my-linter": { PostToolUse: [{ matcher: "run_command", hooks: [{ type: "command", command: "./lint.sh" }] }] }, skillrouter: { enabled: false, PreInvocation: [{ command: "old" }] } }));
  const out = install("antigravity", h, undefined, { hooks: true }).join("\n");
  assert.match(out, /skillrouter hooks set/);
  const d = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(d["my-linter"], { PostToolUse: [{ matcher: "run_command", hooks: [{ type: "command", command: "./lint.sh" }] }] });
  assert.equal(d.skillrouter.enabled, false, "a group the user switched off stays off");
  assert.match(d.skillrouter.PreInvocation[0].command, /skillrouter-hint.* antigravity$/);
  assert.equal(d.skillrouter.PreInvocation.length, 1);
  assert.equal(d.skillrouter.PreToolUse[0].matcher, "");
  assert.match(d.skillrouter.PreToolUse[0].hooks[0].command, /skillrouter-hint.* antigravity gate$/);
  assert.match(hostHooks("antigravity", h), /switched off/);
  d.skillrouter.enabled = true; fs.writeFileSync(file, JSON.stringify(d));
  assert.match(hostHooks("antigravity", h), /^configured/);
  install("antigravity", h, undefined, { hooks: true });
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).skillrouter.PreToolUse.length, 1, "repeatable");
});

test("the launcher's fallback takes only a Node that is new enough", () => {
  const text = launcherScript("/pinned/node", "/x/cli.js", "/x/client.pl", "/x", "/x/sock");
  assert.match(text, /\[ -x "\$c" \] && "\$c" -e 'process\.exit\(\+process\.versions\.node\.split\("\."\)\[0\] >= 20 \? 0 : 1\)' <\/dev\/null 2>\/dev\/null; then NODE="\$c"; break; fi/);
  // With nothing to run the hook, a host that needs an answer gets one from the launcher itself.
  assert.match(text, /antigravity:gate\) echo '\{"decision":"allow"\}'; exit 0;; antigravity:\*\|hermes:\*\) echo '\{\}'; exit 0;;/);
  if (process.platform !== "win32") {
    // The check itself, as the shell runs it: this Node passes, a stand-in that is too old does not.
    const check = (node: string) => spawnSync("sh", ["-c", `"$1" -e 'process.exit(+process.versions.node.split(".")[0] >= 20 ? 0 : 1)' 2>/dev/null`, "sh", node]).status;
    assert.equal(check(process.execPath), 0);
    const old = path.join(home, "old-node"); fs.writeFileSync(old, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    assert.notEqual(check(old), 0);
  }
});

test("backups: old entries are offered for removal, the newest trim's manifest and archives never are", () => {
  const dir = path.join(home, "backups-test"); fs.mkdirSync(dir, { recursive: true });
  const day = 86400e3, now = Date.now();
  const put = (name: string, ageDays: number, body = "x".repeat(1000)) => { const f = path.join(dir, name); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); const t = new Date(now - ageDays * day); fs.utimesSync(f, t, t); if (path.dirname(f) !== dir) fs.utimesSync(path.dirname(f), t, t); };
  put("RESTORE-2026-09-01.json", 70, JSON.stringify({ version: 2, backups: [{ archive: path.join(dir, "claude-2026-09-01.tar") }] }));
  put("RESTORE-2026-09-01.md", 70); put("claude-2026-09-01.tar", 70);
  put("RESTORE-2026-10-01.json", 45, JSON.stringify({ version: 2, backups: [{ archive: path.join(dir, "claude-2026-10-01.tar") }, { archive: "codex-2026-10-01.tar" }] }));
  put("RESTORE-2026-10-01.md", 45); put("claude-2026-10-01.tar", 45); put("codex-2026-10-01.tar", 45);
  put("rules-old/AGENTS.md", 60); put("recent-snapshot/file", 3); put("old-folder-new-file/file", 2); fs.utimesSync(path.join(dir, "old-folder-new-file"), new Date(now - 90 * day), new Date(now - 90 * day));
  const plan = backupPlan(30, dir, now);
  const kept = Object.fromEntries(plan.map((i: any) => [i.name, i.keep]));
  for (const n of ["RESTORE-2026-10-01.json", "RESTORE-2026-10-01.md", "claude-2026-10-01.tar", "codex-2026-10-01.tar"]) assert.match(kept[n], /newest restore manifest/, n);
  assert.match(kept["recent-snapshot"], /newer than 30 days/);
  assert.match(kept["old-folder-new-file"], /newer than 30 days/, "a folder is as new as the newest file in it");
  for (const n of ["RESTORE-2026-09-01.json", "RESTORE-2026-09-01.md", "claude-2026-09-01.tar", "rules-old"]) assert.equal(kept[n], undefined, n);
  assert.match(formatBackups(plan, 30), /Dry run: 4 entries older than 30 days/);
  assert.equal(fs.readdirSync(dir).length, 10, "listing removes nothing");
  const done = pruneBackups(plan, dir);
  assert.deepEqual(done.removed.sort(), ["RESTORE-2026-09-01.json", "RESTORE-2026-09-01.md", "claude-2026-09-01.tar", "rules-old"]);
  assert.deepEqual(fs.readdirSync(dir).sort(), ["RESTORE-2026-10-01.json", "RESTORE-2026-10-01.md", "claude-2026-10-01.tar", "codex-2026-10-01.tar", "old-folder-new-file", "recent-snapshot"]);
  // Which trim is newest goes by the manifest's own date (createdAt, else its name), not the file's time: a copied
  // or synced folder has fresh file times on old manifests.
  const d2 = path.join(home, "backups-order"); fs.mkdirSync(d2);
  const at = (name: string, ageDays: number, body: string) => { fs.writeFileSync(path.join(d2, name), body); const t = new Date(now - ageDays * day); fs.utimesSync(path.join(d2, name), t, t); };
  at("RESTORE-2026-01-01T00-00-00.json", 40, JSON.stringify({ version: 2, backups: [{ archive: "jan.tar" }] })); at("jan.tar", 40, "x");
  at("RESTORE-2026-09-01T00-00-00.json", 60, JSON.stringify({ version: 2, createdAt: "2026-09-01T00:00:00.000Z", backups: [{ archive: "sep.tar" }] })); at("sep.tar", 60, "x");
  const order = Object.fromEntries(backupPlan(30, d2, now).map((i: any) => [i.name, i.keep]));
  assert.match(order["RESTORE-2026-09-01T00-00-00.json"], /newest restore manifest/);
  assert.match(order["sep.tar"], /newest restore manifest/);
  assert.equal(order["jan.tar"], undefined);
  // A newest manifest that cannot be read: nothing is offered, because which archives it needs is unknown.
  put("RESTORE-2026-11-01.json", 40, "{ broken");
  assert.ok(backupPlan(0, dir, now).every((i: any) => i.keep));
  assert.deepEqual(backupPlan(30, path.join(home, "no-such-dir")), []);
});

test("skill gaps: a recurring job phrased many ways is one line, and jobs that share only boilerplate stay apart", () => {
  const now = new Date().toISOString();
  const s = (query: string, agent = "codex") => ({ ts: now, client: "x", agent, tool: "search_skills", query, hits: [] }) as any;
  const integrity = ["read-only production website integrity verification TLS DNS smoke", "production website integrity guard verify GitHub variable TLS", "read-only production site integrity QA verification",
    "run read-only production integrity checks website TLS certificate", "read-only production integrity validation", "production integrity verification of deployment freeze GitHub variable domain TLS",
    "read-only production website integrity monitoring HTTP TLS GitHub variable", "verify production website integrity read-only smoke TLS", "integrity guard production read-only website verification GitHub"];
  const database = ["read-only production database backup restore verification", "verify production database backup and restore read-only", "production database backup verification restore drill read-only", "read-only production postgres database backup restore check"];
  const cluster = ["read-only production kubernetes cluster health verification", "verify production kubernetes cluster node health read-only", "production kubernetes cluster health check pods read-only"];
  const rows = [...Array(5).fill(integrity).flat().slice(0, 40), ...Array(8).fill(database).flat().slice(0, 30), ...Array(4).fill(cluster).flat()].map((q) => s(q));
  const lines = gapLines(rows).filter((l: string) => /^\s+\d+\s/.test(l));
  assert.equal(lines.length, 3, lines.join("\n"));
  const count = (l: string) => Number(l.trim().split(/\s+/)[0]);
  assert.match(lines[0], /integrity/); assert.ok(count(lines[0]) >= 38 && count(lines[0]) <= 44, lines[0]);
  assert.match(lines[1], /database backup/); assert.equal(count(lines[1]), 30);
  assert.match(lines[2], /kubernetes cluster/); assert.ok(count(lines[2]) >= 10 && count(lines[2]) <= 12, lines[2]);
  assert.ok(rows.some((r: any) => lines[0].endsWith(r.query.slice(0, 110))), "the label is one of the queries");
  assert.deepEqual(gapLines(rows), gapLines(rows), "the same rows give the same lines");
});

test("Hermes's end of turn records what was decided about the skill check", async () => {
  await hint("hermes", hermes("pre_llm_call", "v1", { turn_id: "t1", user_message: PROMPT }));
  const { decisionEvent } = await import("../src/events.js");
  const before = readLog(1).filter((r: any) => r.tool === "verdict" && r.agent === "hermes").length;
  assert.equal(decisionEvent("hermes", hermes("post_llm_call", "v1", { turn_id: "t1", user_message: PROMPT, assistant_response: "Done.\n\nSkills: python-testing", conversation_history: [] })), "");
  const verdicts = readLog(1).filter((r: any) => r.tool === "verdict" && r.agent === "hermes");
  assert.equal(verdicts.length, before + 1);
  assert.deepEqual((verdicts.at(-1) as any).accepted, ["python-testing"]);
  // A reply without the line, an unknown turn, and Antigravity (no end-of-turn hook) record nothing and never throw.
  await hint("hermes", hermes("pre_llm_call", "v2", { turn_id: "t1", user_message: PROMPT }));
  decisionEvent("hermes", hermes("post_llm_call", "v2", { turn_id: "t1", assistant_response: "All done." }));
  decisionEvent("hermes", hermes("post_llm_call", "v3", { turn_id: "zz", assistant_response: "Skills: python-testing" }));
  decisionEvent("antigravity", JSON.stringify({ conversationId: "x", lastUserInput: "y" }));
  decisionEvent("hermes", "not json");
  assert.equal(readLog(1).filter((r: any) => r.tool === "verdict" && r.agent === "hermes").length, before + 1);
});

test("a recurring request is told at once which skills it used before, and loading one opens the gate without a search", async () => {
  const { recallRequest, creditRequest, promptKey, readRecurring, formatRecurring, forgetRecurring } = await import("../src/recurring.js");
  fixture("canary-watch", "Monitor a deployed URL after releases: HTTP status, TLS certificate and page content checks.");
  saveIndex(buildIndexFrom([root])); resetIndexCache();
  // A scheduled job: the same words every run, with a date and a run number that change. Its wording matches no skill.
  const job = (n: number) => `Nightly run ${n} on 2026-11-${10 + n}: confirm the storefront answers and nothing drifted since yesterday evening.`;
  assert.equal(promptKey(job(1)), promptKey(job(2)), "numbers and dates do not make it a different request");
  assert.equal(promptKey(job(1)), promptKey("  NIGHTLY run 7 on 2026-12-01:   confirm the storefront answers and nothing drifted since yesterday evening. "));
  assert.notEqual(promptKey(job(1)), promptKey(job(1) + " Also check the cart."));
  const run = async (n: number, load: boolean) => {
    const session = `job-${n}`;
    const out = await hint("codex", JSON.stringify({ session_id: session, turn_id: `t${n}`, prompt: job(n) }));
    const tool = (name: string, input: object, id: string) => gateEvent("codex", JSON.stringify({ session_id: session, turn_id: `t${n}`, tool_use_id: id, tool_name: name, tool_input: input }));
    if (load) tool("mcp__skillrouter__read_skill", { id: "canary-watch" }, "r");
    return { out, work: () => tool("Bash", { command: "npm run deploy-check" }, "w") };
  };
  // Runs 1 and 2: nothing is known yet; each run loads canary-watch (after its own search).
  assert.equal((await run(1, true)).out, "");
  assert.equal((await run(2, true)).out, "");
  // Run 3: the prompt check names it at once, as a skill to read, and says why.
  const third = await run(3, false);
  const text = JSON.parse(third.out).hookSpecificOutput.additionalContext;
  assert.match(text, /- canary-watch — not preloaded: read_skill\("canary-watch"/);
  assert.match(text, /This same request was answered before with: canary-watch\. Load it unless the task has changed; no new search is needed/);
  // Without loading, the gate still holds the first work call; after the load it does not, with no search made.
  assert.match(third.work(), /permissionDecision":"deny/);
  const fourth = await run(4, true);
  assert.match(fourth.out, /canary-watch/);
  assert.equal(fourth.work(), "");
  const rows = readLog(1);
  assert.ok(rows.some((r: any) => r.tool === "recurring" && r.reason === "recalled" && r.skills?.[0] === "canary-watch"));
  // What is kept: a hash, counts and skill names; never the request's words.
  const stored = fs.readFileSync(path.join(process.env.SKILLROUTER_HOME!, "recurring.json"), "utf8");
  assert.ok(!/storefront|Nightly|drifted/i.test(stored));
  const entry = readRecurring().prompts[promptKey(job(1))];
  assert.equal(entry.n, 4);
  assert.equal(entry.skills["canary-watch"], 3);
  assert.match(formatRecurring(), /4 runs .*canary-watch x3/);
  // One session counts once, however often its hook runs or the skill is loaded; a skill loaded in one session only is not suggested.
  recallRequest("s-once", "t", "some other recurring request with enough words"); recallRequest("s-once", "t", "some other recurring request with enough words");
  creditRequest("s-once", "python-testing"); creditRequest("s-once", "python-testing~2");
  const once = readRecurring().prompts[promptKey("some other recurring request with enough words")];
  assert.equal(once.n, 1); assert.equal(once.skills["python-testing"], 1);
  assert.deepEqual(recallRequest("s-twice", "t", "some other recurring request with enough words").skills, []);
  // Odd skill names, sessions that asked nothing, a damaged file and the off switch are all harmless.
  creditRequest("s-once", "../../etc/passwd"); creditRequest("never-prompted", "python-testing"); creditRequest(undefined, "python-testing");
  assert.ok(!JSON.stringify(readRecurring()).includes("passwd"));
  fs.writeFileSync(path.join(process.env.SKILLROUTER_HOME!, "recurring.json"), "{ broken");
  assert.deepEqual(recallRequest("s-broken", "t", job(1)).skills, []);
  process.env.SKILLROUTER_RECURRING = "0";
  try { assert.deepEqual(recallRequest("s-off", "t", job(1)), { key: promptKey(job(1)), skills: [], runs: 0 }); } finally { delete process.env.SKILLROUTER_RECURRING; }
  forgetRecurring();
  assert.match(formatRecurring(), /No request has been seen twice yet/);
});
