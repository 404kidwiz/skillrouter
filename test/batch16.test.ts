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

const skill = (id: string, words: string) => ({ id, name: id, description: `A skill about ${words} with enough description to pass the gate`, path: "/s/" + id, root: "/s", tokens: tokenize(`${id.replace(/-/g, " ")} ${words} `.repeat(3)) });
saveIndex({ builtAt: "g1", roots: [], tokenizer: 2, skills: [skill("python-testing", "python testing pytest tests fixtures mocking"), ...Array.from({ length: 30 }, (_, i) => skill(`filler-${i}`, `sourdough kiln glaze number ${i} baking pottery`))] } as any);
fs.writeFileSync(path.join(process.env.SKILLROUTER_HOME, "core.txt"), "");

let n = 0;
const session = () => `gate-session-${++n}-${Math.random().toString(36).slice(2)}`;
const prompt = (s: string, turn: string, text: string, agent: "claude" | "codex" | "gemini" | "cursor" = "claude") => hint(agent, JSON.stringify({ session_id: s, prompt_id: turn, prompt: text }));
const work = (s: string, turn: string, extra: Record<string, unknown> = {}) => ({ session_id: s, prompt_id: turn, tool_name: "Bash", tool_input: { command: "pytest -q" }, ...extra });
const gate = (agent: "claude" | "codex" | "gemini" | "cursor", p: object) => gateEvent(agent, JSON.stringify(p));
const task = "write pytest tests for the api client and fix the failing python fixtures";

test("a task turn's first work call is refused with a host-shaped denial that names the next step", async () => {
  const s = session(); await prompt(s, "t1", task);
  const out = JSON.parse(gate("claude", work(s, "t1")));
  assert.equal(out.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.equal(out.hookSpecificOutput.permissionDecision, "deny");
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /search_skills/);
  assert.equal(GATE_REASON.includes("search_skills"), true);
  assert.deepEqual(JSON.parse(formatGate("gemini")), { decision: "deny", reason: GATE_REASON });
  const cursor = JSON.parse(formatGate("cursor"));
  assert.equal(cursor.permission, "deny"); assert.equal(cursor.agent_message, GATE_REASON); assert.ok(cursor.user_message);
  assert.deepEqual(JSON.parse(formatGate("codex")), JSON.parse(formatGate("claude")));
});

test("a search_skills call in the turn lets the work through, whatever the host calls the tool", async () => {
  for (const tool of ["mcp__skillrouter__search_skills", "mcp__plugin_skillrouter_skillrouter__search_skills", "mcp_skillrouter_search_skills", "skillrouter_search_skills", "MCP:search_skills"]) {
    const s = session(); await prompt(s, "t1", task);
    assert.notEqual(gate("claude", work(s, "t1")), "", `${tool}: refused before the search`);
    // The gate hook is the one that sees the search (no post-tool hook is needed, and Codex may not have trusted it yet).
    assert.equal(gate("claude", { session_id: s, prompt_id: "t1", tool_name: tool, tool_input: { query: "pytest tests" } }), "", `${tool}: the search itself is never refused`);
    assert.equal(gate("claude", work(s, "t1")), "", `${tool}: allowed after the search`);
  }
  const other = session(); await prompt(other, "t1", task);
  gate("claude", { session_id: other, prompt_id: "t1", tool_name: "mcp__other__search_skills_elsewhere", tool_input: {} });
  assert.notEqual(gate("claude", work(other, "t1")), "", "another server's tool is not the router's search");
});

test("the gate hook counts skill loads itself: the router's read_skill, a host's skill tool, a SKILL.md read by file or by command", async () => {
  const loads: [string, string, object][] = [
    ["claude", "Skill", { skill: "python-testing" }], ["claude", "mcp__skillrouter__read_skill", { id: "python-testing" }], ["gemini", "activate_skill", { name: "python-testing" }],
    ["cursor", "Read", { file_path: "/home/u/.cursor/skills/python-testing/SKILL.md" }], ["claude", "Bash", { command: "cat ~/.skills/python-testing/SKILL.md" }],
    ["codex", "Bash", { command: "sed -n 1,80p /home/u/.codex/skills/python-testing/SKILL.md" }],
  ];
  for (const [agent, tool, input] of loads) {
    const s = session(); await prompt(s, "t1", task, agent as any);
    const key = agent === "cursor" ? { conversation_id: s, generation_id: "t1" } : { session_id: s, prompt_id: "t1" };
    assert.equal(gate(agent as any, { ...key, tool_name: tool, tool_input: input }), "", `${tool} ${JSON.stringify(input)}`);
    assert.equal(gate(agent as any, { ...key, tool_name: agent === "cursor" ? "Shell" : "Bash", tool_input: { command: "pytest -q" } }), "", `${tool}: the next work call goes through`);
  }
  const s = session(); await prompt(s, "t1", task);
  gate("claude", { session_id: s, prompt_id: "t1", tool_name: "Read", tool_input: { file_path: "/repo/README.md" } });
  assert.notEqual(gate("claude", work(s, "t1")), "", "reading something else is not a load");
});

test("loading a skill in the turn also satisfies the gate: the Skill tool, read_skill, a SKILL.md read", async () => {
  const loads: [string, object][] = [["Skill", { skill: "python-testing" }], ["mcp__skillrouter__read_skill", { id: "python-testing" }], ["Read", { file_path: "/home/u/.skills/python-testing/SKILL.md" }]];
  for (const [tool, input] of loads) {
    const s = session(); await prompt(s, "t1", task);
    await toolEvent("claude", JSON.stringify({ session_id: s, prompt_id: "t1", tool_name: tool, tool_input: input, tool_use_id: "l-" + tool }), false);
    assert.equal(gate("claude", work(s, "t1")), "", tool);
  }
});

test("only work is gated: reads, searches, MCP calls and subagents pass; so does everything on a turn that isn't a task", async () => {
  const s = session(); await prompt(s, "t1", task);
  for (const [tool, input] of [["Read", { file_path: "/repo/src/a.py" }], ["Grep", { pattern: "x" }], ["Bash", { command: "ls -la src" }], ["Bash", { command: "git status" }], ["mcp__other__thing", { a: 1 }]] as [string, object][])
    assert.equal(gate("claude", { session_id: s, prompt_id: "t1", tool_name: tool, tool_input: input }), "", `${tool} ${JSON.stringify(input)}`);
  for (const [tool, input] of [["Edit", { file_path: "/repo/a.py", old_string: "a", new_string: "b" }], ["Write", { file_path: "/repo/a.py", content: "x" }], ["Bash", { command: "npm test" }], ["Bash", { command: "rm -rf build && make" }]] as [string, object][]) {
    const w = session(); await prompt(w, "t1", task); // (a fresh session each: the gate stops after two refusals)
    assert.notEqual(gate("claude", { session_id: w, prompt_id: "t1", tool_name: tool, tool_input: input }), "", `${tool} ${JSON.stringify(input)} is work`);
  }
  const sub = session(); await prompt(sub, "t1", task);
  assert.equal(gate("claude", work(sub, "t1", { agent_id: "agent-7" })), "", "a subagent works from its own brief");
  const talk = session(); await prompt(talk, "t1", "What is next? Do you have suggestions for improvements before moving forward?");
  gate("claude", { session_id: talk, prompt_id: "t1", tool_name: "mcp__skillrouter__search_skills", tool_input: {} });
  await prompt(talk, "t2", "Go ahead and implement the Stripe webhook handler we just talked about");
  assert.equal(gate("claude", work(talk, "t2")), "", "a conversational turn carries on work the session already searched for");
  const none = session();
  assert.equal(gate("claude", work(none, "t1")), "", "no prompt check ever ran for this session: nothing to enforce");
  const sys = session(); await prompt(sys, "t1", "<task-notification>background task finished with exit code 0</task-notification>");
  assert.equal(gate("claude", work(sys, "t1")), "", "system text is not a task");
  assert.equal(gate("claude", { tool_name: "Bash", tool_input: { command: "npm test" } }), "", "no session id");
});

test("the gate steps aside after two refusals, so an agent that cannot search is never stuck", async () => {
  const s = session(); await prompt(s, "t1", task);
  const outs = Array.from({ length: GATE_MAX_DENIALS + 3 }, () => gate("claude", work(s, "t1")));
  assert.deepEqual(outs.map((o) => o !== ""), [true, true, false, false, false]);
  await prompt(s, "t2", "now add a second fixture for the retry path in the python client tests");
  assert.notEqual(gate("claude", work(s, "t2")), "", "a new task turn is gated again");
});

test("a search in an earlier turn doesn't excuse a later task turn", async () => {
  const s = session(); await prompt(s, "t1", task);
  gate("claude", { session_id: s, prompt_id: "t1", tool_name: "mcp__skillrouter__search_skills", tool_input: { query: "x" } });
  assert.equal(gate("claude", work(s, "t1")), "");
  await new Promise((r) => setTimeout(r, 5));
  await prompt(s, "t2", "now add a second fixture for the retry path in the python client tests");
  assert.notEqual(gate("claude", work(s, "t2")), "", "the new turn must search for itself");
});

test("Cursor's shell hook sends a bare command, Gemini and Codex use their own session fields", async () => {
  const c = session(); await prompt(c, "g1", task, "cursor");
  assert.notEqual(gate("cursor", { conversation_id: c, generation_id: "g1", command: "pytest -q", cwd: "/repo" }), "");
  assert.equal(gate("cursor", { conversation_id: c, generation_id: "g1", command: "ls src" }), "", "a read-only command");
  const g = session(); await prompt(g, "", task, "gemini");
  const out = JSON.parse(gate("gemini", { session_id: g, tool_name: "run_shell_command", tool_input: { command: "npm test" } }));
  assert.equal(out.decision, "deny");
  const x = session(); await prompt(x, "turn-9", task, "codex");
  assert.notEqual(gate("codex", { session_id: x, turn_id: "turn-9", tool_name: "Bash", tool_input: { command: "pytest" } }), "");
});

test("SKILLROUTER_GATE=0 turns it off, and bad input never throws", async () => {
  const s = session(); await prompt(s, "t1", task);
  process.env.SKILLROUTER_GATE = "0";
  try { assert.equal(gate("claude", work(s, "t1")), ""); } finally { delete process.env.SKILLROUTER_GATE; }
  for (const bad of ["", "not json", "null", "[]", '{"tool_name":5}', '{"session_id":"x","tool_name":"Bash","tool_input":null}']) assert.equal(gateEvent("claude", bad), "", bad);
});

const { install, CLAUDE_GATE_MATCHER, CODEX_GATE_MATCHER, CURSOR_GATE_MATCHER, GEMINI_GATE_MATCHER, CLAUDE_TOOL_MATCHER, CODEX_TOOL_MATCHER, CURSOR_TOOL_MATCHER, GEMINI_TOOL_MATCHER } = await import("../src/install.js");
const { health } = await import("../src/health.js");
const { fileURLToPath } = await import("node:url");

test("install adds the gate hook for each host, once, next to unrelated hooks, and only on work tools", () => {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), "sr-gate-inst-"));
  fs.mkdirSync(path.join(h, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(h, ".claude", "settings.json"), JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo mine" }] }] } }));
  for (let i = 0; i < 2; i++) for (const a of ["claude", "codex", "cursor", "gemini"] as const) install(a, h);
  const read = (...p: string[]) => JSON.parse(fs.readFileSync(path.join(h, ...p), "utf8")).hooks;
  const claude = read(".claude", "settings.json").PreToolUse;
  assert.equal(claude.length, 2, "the user's own PreToolUse hook is kept, ours added once");
  assert.equal(claude[0].hooks[0].command, "echo mine");
  assert.match(claude[1].hooks[0].command, /skillrouter-hint(?:\.mjs)?['"] claude gate$/);
  assert.equal(claude[1].matcher, CLAUDE_GATE_MATCHER);
  const codex = read(".codex", "hooks.json").PreToolUse; assert.equal(codex.length, 1); assert.equal(codex[0].matcher, CODEX_GATE_MATCHER); assert.match(codex[0].hooks[0].command, / codex gate$/);
  const cursor = read(".cursor", "hooks.json").preToolUse; assert.equal(cursor.length, 1); assert.equal(cursor[0].matcher, CURSOR_GATE_MATCHER); assert.match(cursor[0].command, / cursor gate$/);
  const gemini = read(".gemini", "settings.json").BeforeTool; assert.equal(gemini.length, 1); assert.equal(gemini[0].matcher, GEMINI_GATE_MATCHER); assert.equal(gemini[0].hooks[0].timeout, 5000, "Gemini counts milliseconds");
  // Not a read or another server's tool: those would pay a process start for nothing. Searches and skill loads are watched on purpose.
  for (const [tool, m] of [["Read", CLAUDE_GATE_MATCHER], ["Grep", CLAUDE_GATE_MATCHER], ["mcp__other__thing", CLAUDE_GATE_MATCHER], ["read_file", GEMINI_GATE_MATCHER], ["mcp__other__search_skills", CODEX_GATE_MATCHER], ["Grep", CURSOR_GATE_MATCHER]] as const)
    assert.ok(!new RegExp(`^(?:${m})$`).test(tool), `${tool} is not watched by ${m}`);
  for (const [tool, m] of [["Edit", CLAUDE_GATE_MATCHER], ["PowerShell", CLAUDE_GATE_MATCHER], ["apply_patch", CODEX_GATE_MATCHER], ["Bash", CODEX_GATE_MATCHER], ["Shell", CURSOR_GATE_MATCHER], ["run_shell_command", GEMINI_GATE_MATCHER],
    ["mcp__skillrouter__search_skills", CLAUDE_GATE_MATCHER], ["mcp__plugin_skillrouter_skillrouter__read_skill", CLAUDE_GATE_MATCHER], ["Skill", CLAUDE_GATE_MATCHER], ["mcp__skillrouter__search_skills", CODEX_GATE_MATCHER],
    ["MCP:search_skills", CURSOR_GATE_MATCHER], ["Read", CURSOR_GATE_MATCHER], ["mcp_skillrouter_search_skills", GEMINI_GATE_MATCHER], ["activate_skill", GEMINI_GATE_MATCHER]] as const)
    assert.ok(new RegExp(`^(?:${m})$`).test(tool), `${tool} is watched by ${m}`);
  assert.match(health(h).join("\n"), /claude: .*search gate configured/);
});

test("the plugin's hooks.json and the installer watch the same tools", () => {
  const plugin = JSON.parse(fs.readFileSync(fileURLToPath(new URL("../../hooks/hooks.json", import.meta.url)), "utf8")).hooks;
  assert.equal(plugin.PostToolUse[0].matcher, CLAUDE_TOOL_MATCHER);
  assert.equal(plugin.PreToolUse[0].matcher, CLAUDE_GATE_MATCHER);
  assert.match(plugin.PreToolUse[0].hooks[0].command, /hint claude gate$/);
  // The post-tool matchers are unchanged by the gate, so Codex's trust of the existing PostToolUse entry stays valid.
  assert.equal(CODEX_TOOL_MATCHER, "Bash|apply_patch|mcp__skillrouter__read_skill");
  for (const m of [CURSOR_TOOL_MATCHER, GEMINI_TOOL_MATCHER]) assert.ok(!/search_skills/.test(m));
});

test("the CLI's gate mode and the service protocol carry the same answer as the library call", async () => {
  const { spawnSync } = await import("node:child_process");
  const { ask } = await import("../src/service-client.js");
  const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
  const s = session(); await prompt(s, "t1", task);
  const body = JSON.stringify(work(s, "t1"));
  const run = spawnSync(process.execPath, [cli, "hint", "claude", "gate"], { input: body, encoding: "utf8", env: { ...process.env, SKILLROUTER_SERVICE: "0" } });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(JSON.parse(run.stdout).hookSpecificOutput.permissionDecision, "deny");
  const ok = spawnSync(process.execPath, [cli, "hint", "claude", "gate"], { input: JSON.stringify({ session_id: s, prompt_id: "t1", tool_name: "Read", tool_input: { file_path: "/a" } }), encoding: "utf8", env: { ...process.env, SKILLROUTER_SERVICE: "0" } });
  assert.equal(ok.status, 0); assert.equal(ok.stdout.trim(), "", "allowed: no output at all, which every host reads as 'no objection'");
  // 'gate' is a mode the service serves: with nothing listening the answer is "failed" (start one), not "declined" (not a request it serves).
  assert.equal((await ask("claude", "gate", body, 300, "/nonexistent/svc.sock")).kind, "failed");
});

const { sessionHash } = await import("../src/hint.js");
const { isWork, actionOf } = await import("../src/triggers.js");
const { spawn } = await import("node:child_process");

test("at most two refusals per turn even when the work calls arrive at the same moment", async () => {
  const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
  const s = session(); await prompt(s, "t1", task);
  const body = JSON.stringify(work(s, "t1"));
  const outs = await Promise.all(Array.from({ length: 8 }, () => new Promise<string>((resolve) => {
    const c = spawn(process.execPath, [cli, "hint", "claude", "gate"], { env: { ...process.env, SKILLROUTER_SERVICE: "0" } });
    let out = ""; c.stdout.on("data", (d) => (out += d)); c.on("close", () => resolve(out)); c.stdin.end(body);
  })));
  assert.equal(outs.filter((o) => o.includes('"deny"')).length, GATE_MAX_DENIALS, "exactly the cap, however the processes interleave");
});

test("a state folder that cannot take a refusal makes the gate step aside instead of refusing for ever", { skip: process.platform === "win32" && "file modes mean nothing on Windows" }, async () => {
  const s = session(); await prompt(s, "t1", task);
  const dir = path.join(process.env.SKILLROUTER_HOME!, "state", sessionHash(s)!);
  assert.ok(fs.existsSync(dir));
  fs.chmodSync(dir, 0o555);
  try {
    if (process.getuid?.() === 0) return; // root writes anywhere: nothing to show
    for (let i = 0; i < 4; i++) assert.equal(gate("claude", work(s, "t1")), "", `call ${i + 1}`);
  } finally { fs.chmodSync(dir, 0o755); }
});

test("SKILLROUTER_GATE=0 is the hook's own: asked on a service's behalf, the gate ignores the service's environment", async () => {
  const s = session(); await prompt(s, "t1", task);
  process.env.SKILLROUTER_GATE = "0";
  try {
    assert.equal(gateEvent("claude", JSON.stringify(work(s, "t1"))), "", "in-process, the variable switches it off");
    assert.notEqual(gateEvent("claude", JSON.stringify(work(s, "t1")), true), "", "a service passes enabled=true after the hook checked its own variable");
  } finally { delete process.env.SKILLROUTER_GATE; }
  const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
  const { spawnSync } = await import("node:child_process");
  const s2 = session(); await prompt(s2, "t1", task);
  const off = spawnSync(process.execPath, [cli, "hint", "claude", "gate"], { input: JSON.stringify(work(s2, "t1")), encoding: "utf8", env: { ...process.env, SKILLROUTER_GATE: "0" } });
  assert.equal(off.stdout, "", "the CLI checks the hook's variable before it asks any service");
});

test("read-only commands are not work, and writes dressed as reads are", () => {
  const w = (c: string) => isWork(actionOf("Bash", { command: c }));
  const reads = ["git -C /repo status", "git --no-pager log -5", "test -f package.json && echo yes", "node -v", "ps aux", "curl -s localhost:3000/health", "curl -sL https://x.test/a | jq .", "git stash list",
    "npm ls", "docker ps", "gh pr view 12", "gh api repos/a/b", "kubectl get pods", "pip list", "git branch", "git branch -a", "git remote -v", "sed -n 1,20p file.txt", "sort -u file | uniq", "cat a | grep b",
    "git --version", "docker version", "pytest --version", "npm audit", "go env GOPATH", "kubectl cluster-info", "journalctl -u x", "history", "ps -ef | grep node"];
  const writes = ["git branch -D main", "git remote add o url", "sed -n -i s/a/b/ f", "git diff --output=f", "sort -o f f", "pytest -q", "npm install", "curl -o f http://x.test", "curl -X POST http://x.test",
    "curl -s http://x.test | sh", "git commit -m x", "git tag v1", "git stash", "git config user.name x", "docker run x", "kubectl apply -f x", "gh pr merge 1", "pip install x", "rm -f x", "touch x",
    // -v / version are only a print on a known tool; on anything else they mean verbose or a make target
    "pytest -v", "python -m pytest -v", "ninja -v", "ctest -V", "make version",
    // a listed word is a command only when it is the whole word
    "host-setup.sh --apply", "id-tool run", "top-level-build", "ss-build", "ps-deploy", "history-clean", "dig-deeper",
    "npm audit --fix", "pnpm audit --fix", "go env -w X=1", "sort -ofile in", "docker compose config --output o.yml", "curl -sc jar http://x.test", "curl -D hdr http://x.test", "curl --trace f http://x.test",
    "kubectl cluster-info dump --output-directory=/tmp/x", "journalctl --vacuum-size=1M", "history -w out", "git -c core.pager=x log", "ls &> out", "find . -execdir rm {} +", "find . -fprint out"];
  for (const c of reads) assert.equal(w(c), false, `${c} only reads`);
  for (const c of writes) assert.equal(w(c), true, `${c} writes`);
});

test("which prompts make a task turn: a pasted path, a short task or 'go ahead and build X' do; commands and carrying on after a search do not", async () => {
  const gated = async (text: string, setup?: (s: string) => void) => { const s = session(); setup?.(s); await prompt(s, "t1", text); return gate("claude", work(s, "t1")) !== ""; };
  assert.equal(await gated("/Users/me/app/src/a.ts throws on null input, fix it"), true, "a path is not a slash command");
  assert.equal(await gated("/commit"), false, "a slash command is not a task");
  assert.equal(await gated("fix the login bug"), true, "short, in a session that has not searched");
  assert.equal(await gated("fix the login bug", (s) => gate("claude", { session_id: s, prompt_id: "t0", tool_name: "mcp__skillrouter__search_skills", tool_input: {} })), false, "short, after a search: carries on");
  assert.equal(await gated("Go ahead and implement the Stripe webhook handler with retries"), true, "conversational words, but a fresh session");
  assert.equal(await gated("Implement step 3 of the migration: add the users.email index"), true);
  assert.equal(await gated("Continue fixing the flaky payment webhook test in the python service"), true);
});

test("the gate counts a skill load only when something was really loaded, and only the router's own search", async () => {
  const notLookups: [string, object][] = [
    ["Bash", { command: 'echo "cat x/SKILL.md"' }], ["Bash", { command: 'git commit -m "more tests for SKILL.md"' }], ["Bash", { command: "cat > skills/x/SKILL.md <<'EOF'\nbody\nEOF" }],
    ["Bash", { command: "sed -i 's/more/less/' skills/x/SKILL.md" }], ["mcp__my_skillrouter__search_skills", {}], ["mcp__other__search_skills", {}], ["Read", { file_path: "/repo/README.md" }],
  ];
  for (const [tool, input] of notLookups) {
    const s = session(); await prompt(s, "t1", task);
    gate("claude", { session_id: s, prompt_id: "t1", tool_name: tool, tool_input: input });
    assert.notEqual(gate("claude", work(s, "t1")), "", `${tool} ${JSON.stringify(input)} does not count as a search or a load`);
  }
  const loads: [string, unknown][] = [["Bash", { command: ["bash", "-lc", "cat /s/python-testing/SKILL.md"] }], ["Read", { target_file: "/s/python-testing/SKILL.md" }], ["Read", JSON.stringify({ file_path: "/s/python-testing/SKILL.md" })]];
  for (const [tool, input] of loads) {
    const s = session(); await prompt(s, "t1", task);
    gate("claude", { session_id: s, prompt_id: "t1", tool_name: tool, tool_input: input });
    assert.equal(gate("claude", work(s, "t1")), "", `${tool} ${JSON.stringify(input)} is a load`);
  }
});

test("a slash command may start with a digit or underscore; a path is still a prompt", async () => {
  const { isSlashCommand } = await import("../src/hint.js");
  for (const c of ["/commit", "/3d-jutsu make a scene", "/_x do the thing", "/compound-engineering:ce-plan add x", "/tmp"]) assert.equal(isSlashCommand(c), true, c);
  for (const c of ["/usr/local/bin/foo fails", "/.claude/x", "/ a b", "fix /commit"]) assert.equal(isSlashCommand(c), false, c);
});

test("a trailing 2>&1, 2>/dev/null or other redirect that touches no file does not turn a read into work; a redirect to a real file still does", () => {
  const w = (c: string) => isWork(actionOf("Bash", { command: c }));
  const reads = ["node -v 2>&1", "codex --version 2>&1", "git status 2>/dev/null", "git -C /repo log -3 2>&1", "curl -s localhost:3000/health 2>&1 | head", "ls >/dev/null 2>&1", "ls > /dev/null",
    "docker ps 2>&1 | grep web", "npm ls 2>/dev/null", "gh pr view 12 2>&1", "echo hi >&2", "git branch -a &>/dev/null", "cat README.md 1>/dev/null 2>&1", "ps aux 2>&-"];
  const writes = ["ls > out", "git status > out 2>&1", "echo x >> f 2>/dev/null", "pytest -q 2>&1", "ls &> out", "cat a >&out", "ls 2>&1 > out", "npm install 2>&1 | tail -3", "curl -o f http://x.test 2>/dev/null",
    "git commit -m x 2>&1", "sed -n 1,5p a > b 2>&1"];
  for (const c of reads) assert.equal(w(c), false, `${c} only reads`);
  for (const c of writes) assert.equal(w(c), true, `${c} writes`);
});
