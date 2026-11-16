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
  assert.equal(fromHost("hermes", JSON.stringify({ session_id: "s", prompt: "p" }), false), JSON.stringify({ session_id: "s", prompt: "p" }));
  assert.equal(fromHost("codex", "anything", true), "anything");
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
  for (const [conv, name] of [["a2", "mcp_skillrouter_search_skills"], ["a3", "skillrouter/search_skills"], ["a4", "mcp__skillrouter__search_skills"], ["a5", "search_skills"]]) {
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
  for (const t of ["terminal", "write_file", "patch", "skill_view", "mcp_skillrouter_search_skills", "mcp_skillrouter_read_skill"]) assert.ok(m.test(t), t);
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
    assert.equal(allow.length, 3);
    assert.deepEqual(allow[0], { event: "post_tool_call", command: "/mine/format.sh" });
    assert.deepEqual(allow.slice(1).map((a: any) => [a.event, a.command]), [["pre_llm_call", again.hooks.pre_llm_call[0].command], ["pre_tool_call", again.hooks.pre_tool_call[1].command]]);
    assert.equal(read(h, "profiles", "scout", "shell-hooks-allowlist.json").approvals.length, 2);
    install("hermes", h, undefined, { acceptHooks: true });
    assert.equal(read(h, "shell-hooks-allowlist.json").approvals.length, 3, "approving twice adds nothing");
    assert.match(hostHooks("hermes", h), /approved in Hermes$/);
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
  assert.match(text, /\[ -x "\$c" \] && "\$c" -e 'process\.exit\(\+process\.versions\.node\.split\("\."\)\[0\] >= 20 \? 0 : 1\)' 2>\/dev\/null; then NODE="\$c"; break; fi/);
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
  // A newest manifest that cannot be read: nothing is offered, because which archives it needs is unknown.
  put("RESTORE-2026-11-01.json", 40, "{ broken");
  assert.ok(backupPlan(0, dir, now).every((i: any) => i.keep));
  assert.deepEqual(backupPlan(30, path.join(home, "no-such-dir")), []);
});

test("skill gaps: one recurring job phrased many ways is one line", () => {
  const now = new Date().toISOString();
  const s = (query: string, agent = "codex") => ({ ts: now, client: "x", agent, tool: "search_skills", query, hits: [] }) as any;
  const job = ["read-only production website integrity verification TLS DNS smoke", "production website integrity guard verify GitHub variable TLS", "read-only production site integrity QA verification",
    "run read-only production integrity checks website TLS certificate", "read-only production integrity validation", "production integrity verification of deployment freeze GitHub variable domain TLS",
    "read-only production website integrity monitoring HTTP TLS GitHub variable", "verify production website integrity read-only smoke TLS", "integrity guard production read-only website verification GitHub"];
  const rows = [...job, ...job, ...job].map((q) => s(q)).concat([s("weekly revenue pipeline review", "hermes"), s("weekly revenue pipeline review summary", "hermes"), s("review weekly revenue pipeline", "hermes"), s("configure xbox controller")]);
  const lines = gapLines(rows).filter((l: string) => /^\s+\d+\s/.test(l));
  assert.equal(lines.length, 2, lines.join("\n"));
  assert.match(lines[0], /^\s+27 {2}codex: .*integrity/);
  assert.match(lines[1], /^\s+3 {2}hermes: .*weekly revenue pipeline/);
});
