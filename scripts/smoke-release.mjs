// Exercise shipped files with genuinely separate dependencies and disposable user homes.
// Run with `npm run smoke:release`; no existing host configuration or library is touched.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "skillrouter release Ω "));
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const candidates = [
  process.env.npm_execpath,
  path.join(path.dirname(process.execPath), "node_modules/npm/bin/npm-cli.js"),
  path.resolve(path.dirname(process.execPath), "../lib/node_modules/npm/bin/npm-cli.js"),
].filter(Boolean);
const npm = candidates.find((p) => p.endsWith("npm-cli.js") && fs.existsSync(p));
assert.ok(npm, "Run this script with npm run smoke:release so npm-cli.js is available without a shell");
const steps = [];
function run(command, args, options = {}) {
  const r = spawnSync(command, args, { cwd: root, encoding: "utf8", timeout: 180000, windowsHide: true, ...options });
  assert.equal(r.status, 0, `${path.basename(command)} ${args.join(" ")} failed (${r.error?.message ?? r.signal ?? r.status}):\n${r.stderr}\n${r.stdout}`);
  return r.stdout;
}
function npmRun(args, cwd) {
  return run(process.execPath, [npm, ...args], { cwd, env: { ...process.env, npm_config_audit: "false", npm_config_fund: "false" } });
}
function homeFor(name) {
  const home = path.join(scratch, `${name} home`);
  fs.mkdirSync(path.join(home, ".skills", "smoke-python-testing"), { recursive: true });
  fs.writeFileSync(path.join(home, ".skills", "smoke-python-testing", "SKILL.md"), "---\nname: smoke-python-testing\ndescription: Python pytest testing fixtures and regression tests for retry cancellation\n---\nRelease smoke fixture: verify deterministic retries and cancellation.\n");
  return { ...process.env, HOME: home, USERPROFILE: home, SKILLROUTER_HOME: path.join(home, ".skillrouter"), SKILLROUTER_SERVICE: "0", SKILLROUTER_AGENT: "release-smoke", NODE_PATH: "" };
}
async function exercise(dir, name, dependencyRoot = dir) {
  const cli = path.join(dir, "dist", "src", "cli.js");
  const sdk = fs.realpathSync(createRequire(cli).resolve("@modelcontextprotocol/sdk/server/mcp.js"));
  const relative = path.relative(fs.realpathSync(dependencyRoot), sdk);
  assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative), `${name}: SDK resolved outside the isolated install`);
  assert.equal(fs.lstatSync(path.join(dependencyRoot, "node_modules")).isSymbolicLink(), false, `${name}: dependencies must not link to the developer checkout`);
  const env = homeFor(name);
  run(process.execPath, [cli, "index"], { cwd: dir, env });
  assert.match(run(process.execPath, [cli, "search", "python pytest testing"], { cwd: dir, env }), /smoke-python-testing/);
  assert.match(run(process.execPath, [cli, "eval", "--ci"], { cwd: dir, env }), /\bPASS\b/);
  const client = new Client({ name: `skillrouter-${name}-smoke`, version: "1" });
  const transport = new StdioClientTransport({ command: process.execPath, args: [cli, "mcp"], cwd: dir, env, stderr: "pipe" });
  let errors = "";
  transport.stderr?.on("data", (data) => { errors += data.toString(); });
  try {
    await client.connect(transport, { timeout: 15000 });
    assert.equal(client.getServerVersion()?.version, pkg.version, "MCP must report the shipped package version");
    const listed = await client.listTools({}, { timeout: 10000 });
    assert.deepEqual(listed.tools.map((t) => t.name).sort(), ["read_skill", "search_skills"]);
    const search = await client.callTool({ name: "search_skills", arguments: { query: "python pytest testing", top_k: 3 } }, undefined, { timeout: 10000 });
    assert.ok(!search.isError, errors);
    assert.match(JSON.stringify(search.content), /smoke-python-testing/);
    const read = await client.callTool({ name: "read_skill", arguments: { id: "smoke-python-testing" } }, undefined, { timeout: 10000 });
    assert.ok(!read.isError, errors);
    assert.match(JSON.stringify(read.content), /Release smoke fixture: verify deterministic retries/);
  } finally { await client.close(); await transport.close(); }
  // Exercise all supported config dialects without starting actual AI agents or spending model credits.
  run(process.execPath, [cli, "install", "claude", "codex", "cursor", "gemini", "opencode", "antigravity"], { cwd: dir, env });
  const config = JSON.parse(fs.readFileSync(path.join(env.HOME, ".gemini/config/mcp_config.json"), "utf8"));
  assert.ok(config.mcpServers.skillrouter, "Antigravity canonical config was not installed");
  const live = run(process.execPath, [cli, "doctor", "--live", "claude", "codex", "cursor", "gemini", "opencode", "antigravity"], { cwd: dir, env });
  assert.doesNotMatch(live, /^\s+\w+: FAILED\b/m);
  for (const host of ["claude", "codex", "cursor", "gemini", "opencode", "antigravity"]) {
    assert.match(live, new RegExp(`${host}: connected in .*tools search_skills, read_skill`), `${name}: ${host} did not connect with both router tools`);
  }
  const recovery = path.join(env.HOME, ".claude", "skills", "release-recovery", "SKILL.md");
  const original = Buffer.from("Release recovery fixture: exact bytes ü\n");
  fs.mkdirSync(path.dirname(recovery), { recursive: true });
  fs.writeFileSync(recovery, original);
  run(process.execPath, [cli, "trim", "claude"], { cwd: dir, env });
  assert.deepEqual(fs.readFileSync(recovery), original, "trim preview changed the original file");
  run(process.execPath, [cli, "trim", "claude", "--apply"], { cwd: dir, env });
  assert.ok(!fs.existsSync(recovery), "trim did not move the fixture");
  const backups = path.join(env.SKILLROUTER_HOME, "backups");
  const manifests = fs.readdirSync(backups).filter((f) => /^RESTORE-.*\.json$/.test(f));
  assert.equal(manifests.length, 1);
  const manifest = path.join(backups, manifests[0]);
  run(process.execPath, [cli, "restore", manifest], { cwd: dir, env });
  assert.ok(!fs.existsSync(recovery), "restore preview changed the agent folder");
  run(process.execPath, [cli, "restore", manifest, "--apply"], { cwd: dir, env });
  assert.deepEqual(fs.readFileSync(recovery), original, "installed package failed byte-exact recovery");
  steps.push(`${name}: own dependencies, index/search, fixture eval, MCP initialize/list/search/read, six host installs/live checks, trim/restore bytes PASS`);
}

try {
  const output = npmRun(["pack", "--ignore-scripts", "--json", "--pack-destination", scratch], root);
  const packed = JSON.parse(output.slice(output.indexOf("[")))[0];
  const included = new Set(packed.files.map((f) => f.path));
  for (const f of ["npm-shrinkwrap.json", "eval/prompts.jsonl", "eval/skills/python-testing/SKILL.md", "LICENSE", "dist/src/cli.js"]) assert.ok(included.has(f), `archive omits ${f}`);
  assert.ok(![...included].some((p) => /^(?:verification|dist\/test|node_modules)\//.test(p)), "archive includes private evidence, tests, or installed modules");
  const consumer = path.join(scratch, "npm consumer");
  fs.mkdirSync(consumer);
  fs.writeFileSync(path.join(consumer, "package.json"), JSON.stringify({ name: "skillrouter-smoke-consumer", private: true, version: "1.0.0" }));
  npmRun(["install", "--ignore-scripts", "--omit=dev", "--omit=optional", "--no-audit", "--no-fund", path.join(scratch, packed.filename)], consumer);
  const artifact = path.join(consumer, "node_modules", "skillrouter");
  // npm can hoist dependencies into the consumer; never repair this install before testing it.
  await exercise(artifact, "npm-artifact", consumer);
  const plugin = path.join(scratch, "clean plugin");
  fs.mkdirSync(plugin);
  // Copy only distribution inputs, exactly as a clean source plugin copy would receive them.
  for (const entry of new Set([...pkg.files, "package.json", "npm-shrinkwrap.json", "LICENSE"])) {
    fs.cpSync(path.join(root, entry), path.join(plugin, entry), { recursive: true });
  }
  // Dependencies are installed the way Claude Code documents it: npm runs in a folder of its own that holds only the
  // dependency list, and the resulting node_modules moves into the plugin. (A CI run on Windows once lost dist/ to an
  // npm ci run inside the plugin copy; this keeps npm away from the plugin's own files.)
  const install = path.join(scratch, "plugin install");
  fs.mkdirSync(install);
  for (const f of ["package.json", "npm-shrinkwrap.json"]) fs.copyFileSync(path.join(root, f), path.join(install, f));
  npmRun(["ci", "--ignore-scripts", "--omit=dev", "--omit=optional", "--no-audit", "--no-fund"], install);
  fs.renameSync(path.join(install, "node_modules"), path.join(plugin, "node_modules"));
  for (const f of ["dist/src/cli.js", "node_modules/@modelcontextprotocol/sdk/package.json"]) assert.ok(fs.existsSync(path.join(plugin, f)), `clean plugin copy is missing ${f}; it holds: ${fs.readdirSync(plugin).join(", ")}`);
  await exercise(plugin, "source-plugin");
  console.log(steps.join("\n"));
  console.log(`Release smoke PASS: ${pkg.version}, ${process.platform}, Node ${process.version}`);
} catch (error) {
  console.error(`Smoke artifacts retained at ${scratch}`);
  throw error;
}
fs.rmSync(scratch, { recursive: true, force: true });
