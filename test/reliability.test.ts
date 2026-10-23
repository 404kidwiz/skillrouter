import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "skillrouter-reliability-"));
process.env.SKILLROUTER_HOME = path.join(scratch, "router");
fs.mkdirSync(process.env.SKILLROUTER_HOME);
const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const { report, followsHint, readLog } = await import("../src/report.js");
const { install, addHook, openCodePlugin, resolveNode } = await import("../src/install.js");
const { configuration, health } = await import("../src/health.js");
const { runHint } = await import("../src/hint.js");
const logFile = path.join(process.env.SKILLROUTER_HOME, "usage.jsonl");
const indexFile = path.join(process.env.SKILLROUTER_HOME, "index.json");
const rows = () => readLog(7);

process.on("exit", () => fs.rmSync(scratch, { recursive: true, force: true }));

test("attribution excludes prior/cross-agent/cross-session/uncorrelated/late/failed reads", () => {
  const h = { ts: new Date().toISOString(), client: "hook/codex", tool: "hint", agent: "codex", session: "session", hint_id: "prompt-1", hits: [["demo", 1] as [string, number]] };
  const r = { ...h, tool: "read_skill", found: true, skill: "demo", ts: new Date(Date.parse(h.ts) + 1000).toISOString() };
  assert.equal(followsHint(h, r), true);
  for (const change of [{ ts: new Date(Date.parse(h.ts) - 1).toISOString() }, { agent: "claude" }, { session: "other" }, { hint_id: "other" }, { skill: "other" }, { found: false }, { ts: new Date(Date.parse(h.ts) + 1800001).toISOString() }])
    assert.equal(followsHint(h, { ...r, ...change }), false);
  assert.equal(followsHint({ ...h, hint_id: undefined, session: undefined }, { ...r, hint_id: undefined, session: undefined }), false);
  assert.match(report(7, [h, r]), /1\/1 shown hints have a correlated organic successful load/);
  assert.match(report(7, [h, { ...r, ts: new Date(Date.parse(h.ts) - 1).toISOString() }]), /0\/1 shown hints/);
});

test("log reader tolerates malformed and structurally invalid records", () => {
  fs.writeFileSync(logFile, 'null\n{}\ninvalid\n' + JSON.stringify({ ts: new Date().toISOString(), client: "hook/codex", tool: "hint", hits: [null] }) + '\n');
  assert.deepEqual(rows(), []);
});

test("installer never pins a Node binary that another tool manages", () => {
  const home = path.join(scratch, "node-home");
  const managedNode = path.join(home, ".hermes", "node", "bin", "node");
  const freeNode = path.join(scratch, "free-bin", "node");
  for (const p of [managedNode, freeNode]) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, "#!/bin/sh\n", { mode: 0o755 }); }
  const saved = { PATH: process.env.PATH, SKILLROUTER_NODE: process.env.SKILLROUTER_NODE };
  try {
    process.env.SKILLROUTER_NODE = "/custom/node";
    assert.equal(resolveNode(), "/custom/node");
    delete process.env.SKILLROUTER_NODE;
    process.env.PATH = [path.dirname(managedNode), path.dirname(freeNode)].join(path.delimiter);
    const picked = resolveNode();
    assert.ok(!picked.includes(".hermes"), picked);
    assert.ok(picked === process.execPath || picked === freeNode, picked);
  } finally { Object.assign(process.env, saved); if (saved.SKILLROUTER_NODE === undefined) delete process.env.SKILLROUTER_NODE; }
});

test("installer is repeatable in a scratch home and preserves unrelated hooks", () => {
  const home = path.join(scratch, "home");
  fs.mkdirSync(home);
  const data: any = { hooks: { UserPromptSubmit: [{ hooks: [{ command: "node '/old skillrouter/dist/src/cli.js' hint claude" }, { command: "echo preserved" }] }] } };
  addHook(data, "UserPromptSubmit", { hooks: [{ command: "node '/new/cli.js' hint claude" }] });
  addHook(data, "UserPromptSubmit", { hooks: [{ command: "node '/new/cli.js' hint claude" }] });
  assert.equal(data.hooks.UserPromptSubmit.length, 2);
  assert.match(JSON.stringify(data), /echo preserved/);
  for (const agent of ["claude", "codex", "cursor", "gemini", "opencode"] as const) {
    install(agent, home);
    install(agent, home);
    const status = configuration(agent, home);
    assert.match(status.hook, /configured|plugin present/, agent);
    assert.match(status.mcp, /configured/, agent);
  }
  const toml = path.join(home, ".codex/config.toml");
  fs.writeFileSync(toml, '[mcp_servers.skillrouter]\ncommand = "npx"\nargs = ["old"]\nenabled = false\n[mcp_servers.skillrouter.env]\nCUSTOM = "preserved"\n[other]\nflag = true\n');
  install("codex", home);
  const updated = fs.readFileSync(toml, "utf8");
  assert.match(updated, /CUSTOM = "preserved"/);
  assert.match(updated, /SKILLROUTER_AGENT = "codex"/);
  assert.match(updated, /enabled = false/);
  assert.match(updated, /\[other\]\nflag = true/);
  assert.doesNotMatch(updated, /command = "npx"/);
  const cursor = JSON.parse(fs.readFileSync(path.join(home, ".cursor/hooks.json"), "utf8"));
  assert.equal(cursor.hooks.beforeSubmitPrompt.length, 1);
  assert.doesNotMatch(JSON.stringify(cursor), /npx/);
  fs.writeFileSync(path.join(home, ".cursor/hooks.json"), "{");
  assert.match(configuration("cursor", home).hook, /invalid/);
  fs.writeFileSync(path.join(home, ".cursor/mcp.json"), JSON.stringify({ mcpServers: { skillrouter: { command: "node", disabled: true } } }));
  assert.equal(configuration("cursor", home).mcp, "disabled");
  assert.match(health(home).join("\n"), /activation unverified|connection unverified/);
});

test("hook records skips/errors/matches, stays lexical with an embedding index, and never logs prompt text", () => {
  fs.rmSync(indexFile, { force: true });
  function invoke(input: unknown) {
    const result = spawnSync(process.execPath, [cli, "hint", "codex"], { input: JSON.stringify(input), env: process.env, encoding: "utf8", timeout: 4000 });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  }
  invoke({ prompt: "short" }); assert.equal(rows().at(-1)?.reason, "skipped_short_prompt");
  invoke({ prompt: "/command" }); assert.equal(rows().at(-1)?.reason, "skipped_command");
  invoke(null); assert.equal(rows().at(-1)?.reason, "invalid_input");
  invoke({ prompt: "a sufficiently long request without an index" }); assert.equal(rows().at(-1)?.reason, "missing_index");
  const tokens = Array.from({ length: 80 }, (_, i) => `term${i}`);
  fs.writeFileSync(indexFile, JSON.stringify({ builtAt: new Date().toISOString(), roots: [], skills: [{ id: "demo", name: "demo", description: "demo", path: scratch, root: scratch, tokens }], embeddings: { demo: [1] } }));
  const output = invoke({ prompt: tokens.join(" "), session_id: "private-session-value" });
  const text = JSON.parse(output).hookSpecificOutput.additionalContext;
  assert.match(text, /hint_id:/);
  assert.equal(rows().at(-1)?.reason, "shown");
  assert.doesNotMatch(fs.readFileSync(logFile, "utf8"), /private-session-value|term79/);
  invoke({ prompt: "unrelated vocabulary without any matches" }); assert.equal(rows().at(-1)?.reason, "no_match");
  fs.writeFileSync(indexFile, "{");
  invoke({ prompt: "a sufficiently long request with corrupt index" }); assert.equal(rows().at(-1)?.reason, "index_error");
});

test("hook deadline kills synchronous stalls and returns empty output", async () => {
  const stalled = path.join(scratch, "stall.cjs");
  fs.writeFileSync(stalled, "while (true) {}\n");
  const start = Date.now();
  assert.equal(await runHint("codex", "{}", stalled, 150), "");
  assert.ok(Date.now() - start < 2000);
  assert.equal(rows().at(-1)?.reason, "timeout");
});

test("OpenCode plugin bounds stalled child execution", async () => {
  const stalled = path.join(scratch, "stall.cjs");
  const plugin = path.join(scratch, "plugin.mjs");
  fs.writeFileSync(plugin, openCodePlugin(process.execPath, [stalled], 150));
  const { SkillrouterHints } = await import(pathToFileURL(plugin).href);
  const handlers = await SkillrouterHints();
  const start = Date.now();
  await handlers["chat.message"]({}, { message: { id: "message" }, parts: [{ type: "text", text: "a long enough request" }] });
  assert.ok(Date.now() - start < 2000);
});

test("MCP logs only completed loads as successful and carries hint correlation", async () => {
  const skill = path.join(scratch, "demo"); fs.mkdirSync(skill);
  fs.writeFileSync(path.join(skill, "SKILL.md"), "# demo");
  fs.writeFileSync(indexFile, JSON.stringify({ builtAt: new Date().toISOString(), roots: [], skills: [{ id: "demo", name: "demo", description: "demo", path: skill, root: scratch, tokens: ["demo"] }] }));
  const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => typeof e[1] === "string"));
  const transport = new StdioClientTransport({ command: process.execPath, args: [cli, "mcp"], env: { ...env, SKILLROUTER_AGENT: "codex" } });
  const client = new Client({ name: "regression", version: "1" });
  try {
    await client.connect(transport);
    const result = await client.callTool({ name: "read_skill", arguments: { id: "demo", hint_id: "test-hint" } });
    assert.ok(!result.isError);
    assert.equal(rows().at(-1)?.found, true);
    assert.equal(rows().at(-1)?.hint_id, "test-hint");
    assert.equal(rows().at(-1)?.agent, "codex");
    fs.unlinkSync(path.join(skill, "SKILL.md"));
    const failed = await client.callTool({ name: "read_skill", arguments: { id: "demo" } });
    assert.equal(failed.isError, true);
    assert.equal(rows().at(-1)?.found, false);
    assert.equal(rows().at(-1)?.reason, "read_error");
  } finally { await client.close(); }
});


test("CLI bounds open stdin and oversized input without failing the prompt", async () => {
  const child = spawn(process.execPath, [cli, "hint", "cursor"], { env: process.env, stdio: ["pipe", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (data) => { output += data; });
  const watchdog = setTimeout(() => child.kill("SIGKILL"), 4000);
  try {
    const code = await new Promise((resolve) => child.on("close", resolve));
    assert.equal(code, 0);
    assert.equal(JSON.parse(output).continue, true);
    assert.equal(rows().at(-1)?.reason, "input_timeout");
  } finally { clearTimeout(watchdog); child.stdin.destroy(); }
  const oversized = spawnSync(process.execPath, [cli, "hint", "cursor"], { input: "x".repeat(270000), encoding: "utf8", env: process.env, timeout: 4000 });
  assert.equal(oversized.status, 0);
  assert.equal(JSON.parse(oversized.stdout).continue, true);
  assert.equal(rows().at(-1)?.reason, "input_too_large");
});
