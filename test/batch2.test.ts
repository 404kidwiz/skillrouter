import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "skillrouter-batch2-"));
process.env.HOME = home;
process.env.SKILLROUTER_HOME = path.join(home, ".skillrouter");
const { BM25, tokenize, expand } = await import("../src/bm25.js");
const { hintText } = await import("../src/hint.js");
const { install, writeLauncher, LAUNCHER } = await import("../src/install.js");
const { mcpSpec, liveCheck } = await import("../src/live.js");
const { mcpOnlyConfiguration } = await import("../src/health.js");

test("synonyms and the name-match bonus route a docker prompt to the docker skill", () => {
  // The two real descriptions that collided on this prompt before the bonus and synonyms existed.
  const docs = [
    { id: "llama-cpp", name: tokenize("llama-cpp"), tokens: tokenize("llama-cpp Runs LLM inference on CPU, Apple Silicon, and consumer GPUs without NVIDIA hardware. Use for edge deployment") },
    { id: "docker-best-practices", name: tokenize("docker-best-practices"), tokens: tokenize("docker-best-practices Docker best practices including multi-stage builds, compose patterns, image optimization, and security") },
  ];
  const hits = new BM25(docs).search("why is my docker build slow on M1", 2);
  assert.equal(hits[0].id, "docker-best-practices");
  assert.ok(expand(["pytest"]).includes("python"));
  // A synonym-only match scores but is not counted as a prompt-made match.
  assert.equal(new BM25([{ id: "x", tokens: tokenize("container images") }]).search("docker", 1)[0].matched, 0);
});

test("hint text says how to load each candidate: preloaded vs read_skill with the hint id", () => {
  const skill = (id: string) => ({ id, name: id, description: "Use when doing X", path: "/p", root: "/r", tokens: [] });
  const text = hintText([{ skill: skill("impeccable"), score: 1, raw: 20, matched: 3 }, { skill: skill("python-testing"), score: 0.9, raw: 18, matched: 2 }], "hint-1", new Set(["impeccable"]));
  assert.match(text, /impeccable \(1\.00\) — preloaded: invoke it with the Skill tool/);
  assert.match(text, /python-testing \(0\.90\) — not preloaded: read_skill\("python-testing", hint_id="hint-1"\)/);
  assert.match(text, /when: Use when doing X/);
});

test("hook commands point at a stable launcher, so a reinstall with another Node changes nothing the host trusts", () => {
  install("codex", home);
  const first = JSON.parse(fs.readFileSync(path.join(home, ".codex", "hooks.json"), "utf8")).hooks.UserPromptSubmit.at(-1).hooks[0].command;
  const launcher = path.join(home, ".skillrouter", "bin", "skillrouter-hint");
  assert.equal(first, `'${launcher}' codex`);
  writeLauncher("/some/other/node", "/elsewhere/cli.js", launcher);
  install("codex", home);
  const second = JSON.parse(fs.readFileSync(path.join(home, ".codex", "hooks.json"), "utf8")).hooks.UserPromptSubmit;
  assert.equal(second.length, 1);
  assert.equal(second[0].hooks[0].command, first);
  assert.match(fs.readFileSync(launcher, "utf8"), /^#!\/bin\/sh\n/);
  assert.ok((fs.statSync(launcher).mode & 0o111) !== 0, "launcher is executable");
  void LAUNCHER;
});

test("MCP-only hosts: install writes their configs, keeps 0600, and doctor can read them back", async () => {
  const oc = path.join(home, ".openclaude.json");
  fs.writeFileSync(oc, JSON.stringify({ mcpServers: { other: { command: "x" } }, secret: "keep" }), { mode: 0o600 });
  install("openclaude", home);
  install("antigravity", home);
  const written = JSON.parse(fs.readFileSync(oc, "utf8"));
  assert.equal(written.secret, "keep");
  assert.equal(written.mcpServers.other.command, "x");
  assert.equal(written.mcpServers.skillrouter.env.SKILLROUTER_AGENT, "openclaude");
  assert.equal(fs.statSync(oc).mode & 0o777, 0o600);
  assert.equal(mcpOnlyConfiguration("openclaude", home), "configured (connection unverified)");
  assert.equal(mcpOnlyConfiguration("hermes", home), "missing");
  assert.match(install("hermes", home)[0], /missing \(Hermes not installed\)/);
  const spec = mcpSpec("antigravity", home);
  assert.ok(spec && spec.args.at(-1) === "mcp" && spec.env.SKILLROUTER_AGENT === "antigravity");
  // Codex TOML and Hermes YAML are parsed, not just JSON.
  install("codex", home);
  assert.equal(mcpSpec("codex", home)?.env.SKILLROUTER_AGENT, "codex");
  fs.mkdirSync(path.join(home, ".hermes"), { recursive: true });
  fs.writeFileSync(path.join(home, ".hermes", "config.yaml"), "mcp_servers:\n  skillrouter:\n    command: /usr/bin/node\n    args:\n      - /x/cli.js\n      - mcp\n    env:\n      SKILLROUTER_AGENT: hermes\n  other:\n    command: y\n");
  assert.deepEqual(mcpSpec("hermes", home), { command: "/usr/bin/node", args: ["/x/cli.js", "mcp"], env: { SKILLROUTER_AGENT: "hermes" } });
});

test("QA regressions: TOML keeps 0600, pristine backup survives reinstall, stemmed synonyms, stale index re-stemmed", () => {
  const home2 = fs.mkdtempSync(path.join(os.tmpdir(), "skillrouter-toml-")); // untouched by the other tests' installs
  const toml = path.join(home2, ".codex", "config.toml");
  fs.mkdirSync(path.dirname(toml), { recursive: true });
  fs.writeFileSync(toml, 'api_key = "secret"\n');
  fs.chmodSync(toml, 0o600);
  install("codex", home2);
  assert.equal(fs.statSync(toml).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(`${toml}.bak-skillrouter`, "utf8"), 'api_key = "secret"\n');
  install("codex", home2);
  assert.equal(fs.readFileSync(`${toml}.bak-skillrouter`, "utf8"), 'api_key = "secret"\n', "first backup is kept");
  // Synonym keys and values meet stemmed tokens on both sides.
  assert.equal(new BM25([{ id: "k", tokens: tokenize("Deploy to a kubernetes cluster") }]).search("k8s", 1)[0]?.id, "k");
  assert.equal(new BM25([{ id: "p", tokens: tokenize("postgres tuning") }]).search("pg", 1)[0]?.id, "p");
  assert.ok(expand(tokenize("postgres")).includes("sql"));
});

test("an index built by the older tokenizer still matches stemmed queries", async () => {
  const { loadIndex, saveIndex } = await import("../src/index.js");
  const { search } = await import("../src/search.js");
  saveIndex({ builtAt: new Date().toISOString(), roots: [], skills: [{ id: "old", name: "old", description: "", path: "/p", root: "/r", tokens: ["run", "tests", "builds"] }] } as any);
  assert.equal(loadIndex()?.tokenizer, undefined);
  const hits = await search("run the tests builds", 1);
  assert.equal(hits[0]?.matched, 3);
});

test("Codex TOML and Hermes YAML parsers take quotes, spaces, flow lists and inline env", async () => {
  const { codexSpec, hermesSpec } = await import("../src/live.js");
  assert.deepEqual(codexSpec("[mcp_servers.skillrouter]\ncommand = '/opt/my node/bin/node'\nargs = ['/x y/cli.js', \"mcp\"]\nenv = { SKILLROUTER_AGENT = \"codex\" }\nenabled = false\n[other]\n"),
    { command: "/opt/my node/bin/node", args: ["/x y/cli.js", "mcp"], env: { SKILLROUTER_AGENT: "codex" }, disabled: true });
  assert.equal(codexSpec("[mcp_servers.other]\ncommand = \"x\"\n"), null);
  assert.deepEqual(hermesSpec("mcp_servers:\n  skillrouter:\n    command: /opt/my node/bin/node\n    args:\n      - /Users/Jane Doe/cli.js\n      - mcp"),
    { command: "/opt/my node/bin/node", args: ["/Users/Jane Doe/cli.js", "mcp"], env: {} });
  assert.deepEqual(hermesSpec("other:\n  skillrouter:\n    command: wrong\nmcp_servers:\n  skillrouter:\n    command: \"/usr/bin/node\"\n    args: [\"/x/cli.js\", 'mcp']\n    env:\n      SKILLROUTER_AGENT: 'hermes'\n  other:\n    command: y\n"),
    { command: "/usr/bin/node", args: ["/x/cli.js", "mcp"], env: { SKILLROUTER_AGENT: "hermes" } });
  assert.equal(hermesSpec("other:\n  skillrouter:\n    command: wrong\n"), null);
});

test("doctor --live starts a configured server and lists its tools, and reports a broken one", async () => {
  fs.mkdirSync(path.join(home, ".skillrouter"), { recursive: true });
  fs.writeFileSync(path.join(home, ".skillrouter", "index.json"), JSON.stringify({ builtAt: new Date().toISOString(), roots: [], skills: [] }));
  install("cursor", home);
  fs.writeFileSync(path.join(home, ".gemini", "settings.json"), JSON.stringify({ mcpServers: { skillrouter: { command: "/nonexistent/node", args: ["mcp"] } } }));
  const started = Date.now();
  const lines = await liveCheck(["cursor", "gemini", "claude"], home, 10000);
  assert.match(lines[0], /cursor: connected in \d+ ms; tools search_skills, read_skill/);
  assert.match(lines[1], /gemini: FAILED/);
  assert.match(lines[2], /claude: not configured/);
  assert.ok(Date.now() - started < 8000, "the check returns as soon as the servers answer, not at the timeout");
});
