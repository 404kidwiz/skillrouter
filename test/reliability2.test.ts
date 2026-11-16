import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "skillrouter-rel2-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.SKILLROUTER_HOME = path.join(home, ".skillrouter");
process.env.SKILLROUTER_SERVICE = "0";
process.on("exit", () => fs.rmSync(home, { recursive: true, force: true }));

const { buildIndexFrom, saveIndex } = await import("../src/index.js");
const { resetIndexCache, findSkill, findSkillForRead, logUsage, usageArchives } = await import("../src/search.js");
const { routeSearch, selectWeak, formatSearch, formatExplanation } = await import("../src/routing.js");
const { volatileNode, launcherScript, writeLauncher, snapshotApp, patchHermesProfiles, hermesProfilePatch, setInstallCli, pinProblems, NODE } = await import("../src/install.js");
const { gapLines, readLog, report } = await import("../src/report.js");
const posix = process.platform !== "win32";

const root = path.join(home, "skills");
function fixture(name: string, description: string) {
  const dir = path.join(root, name); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\nbody of ${name}\n`);
}
fixture("python-testing", "Write Python pytest tests with fixtures and mocks for regression coverage.");
fixture("vercel-deployment", "Deploy Next.js applications to Vercel with environment configuration and domains.");
fixture("redis-patterns", "Redis caching patterns, distributed locks and rate limiting for backend services.");
for (let i = 0; i < 80; i++) fixture(`filler-${i}`, `Pottery kiln glaze clay wheel hobby ${i}`);
const built = buildIndexFrom([root]);
saveIndex(built); resetIndexCache();

const hit = (id: string, over: Record<string, unknown>) => ({ skill: { id, name: id, description: "A description long enough to count as one.", path: "/x", tokens: [] } as any, score: 1, raw: 0, matched: 0, ...over }) as any;

test("the weak tier keeps candidates with real evidence and drops the rest", () => {
  const picked = selectWeak([
    hit("meaning-and-a-word", { score: 1, cos: 0.44, matched: 1, raw: 9 }),
    hit("words-with-some-meaning", { score: 0.95, cos: 0.34, matched: 2, raw: 16 }),
    hit("meaning-without-a-word", { score: 0.9, cos: 0.47, matched: 0, raw: 0 }),
    hit("one-word-little-meaning", { score: 0.9, cos: 0.36, matched: 1, raw: 18 }),
    hit("far-behind-the-best", { score: 0.5, cos: 0.45, matched: 2, raw: 18 }),
  ], 20);
  assert.deepEqual(picked.map((h: any) => h.skill.id), ["meaning-and-a-word", "words-with-some-meaning"]);
  // Without the semantic layer: two matched words at 75% of the lexical floor.
  assert.deepEqual(selectWeak([hit("a", { raw: 15.5, matched: 2 }), hit("b", { score: 0.9, raw: 14, matched: 2 }), hit("c", { score: 0.9, raw: 30, matched: 1 })], 20).map((h: any) => h.skill.id), ["a"]);
  // Never more than three, and a skill without a real description is not offered.
  assert.equal(selectWeak([1, 2, 3, 4, 5].map((i) => hit(`s${i}`, { cos: 0.45, matched: 2, raw: 20 })), 20, 5).length, 3);
  const bare = hit("bare", { cos: 0.6, matched: 3, raw: 40 }); bare.skill.description = "short";
  assert.equal(selectWeak([bare], 20).length, 0);
  // Order of the input does not matter, and a hit without any description is skipped rather than thrown on.
  assert.deepEqual(selectWeak([hit("low", { score: 0.3, cos: 0.45, matched: 2, raw: 20 }), hit("high", { score: 1, cos: 0.45, matched: 2, raw: 20 })], 20).map((h: any) => h.skill.id), ["high"]);
  const none = hit("none", { cos: 0.6, matched: 3, raw: 40 }); delete none.skill.description;
  assert.equal(selectWeak([none], 20).length, 0);
  process.env.SKILLROUTER_WEAK = "0";
  try { assert.equal(selectWeak([hit("a", { cos: 0.6, matched: 3, raw: 40 })], 20).length, 0); } finally { delete process.env.SKILLROUTER_WEAK; }
});

test("a search with no strong match answers with labeled weak candidates, and a strong match is unchanged", async () => {
  const strong = await routeSearch("write python pytest regression tests", { lexicalOnly: true });
  assert.equal(strong.weak, false);
  assert.equal(strong.hits[0]?.skill.name, "python-testing");
  assert.doesNotMatch(formatSearch(strong), /No strong match/);
  // The same library with a higher floor: "limiting for services" matches two words of redis-patterns, enough for
  // the weak tier (75% of the floor) and not for a strong match.
  process.env.SKILLROUTER_MIN_RAW = "15";
  try {
    const weak = await routeSearch("limiting for services", { lexicalOnly: true });
    assert.equal(weak.weak, true);
    assert.deepEqual(weak.hits.map((h: any) => h.skill.name), ["redis-patterns"]);
    assert.ok(weak.decisions.every((d: any) => !d.accepted), "a weak candidate is not reported as relevant");
    const text = formatSearch(weak);
    assert.match(text, /^No strong match\. Weak candidates follow/);
    assert.match(text, /^- redis-patterns@[a-f0-9]{24} \(ranking score [\d.]+; weak\)/m);
    assert.doesNotMatch(text, /relevant\)/);
    const explained = formatExplanation(weak);
    assert.match(explained, /^WEAK redis-patterns: no strong match; returned as a weak candidate/m);
    assert.match(explained, /Returned \(weak tier, no strong match\): redis-patterns/);
    // Switched off, asked for one result, exploratory, and an exact id: each behaves as documented.
    process.env.SKILLROUTER_WEAK = "0";
    try { assert.equal((await routeSearch("limiting for services", { lexicalOnly: true })).hits.length, 0); } finally { delete process.env.SKILLROUTER_WEAK; }
    assert.equal((await routeSearch("limiting for services", { lexicalOnly: true, k: 1 })).hits.length, 1);
    const exploratory = await routeSearch("limiting for services", { lexicalOnly: true, exploratory: true });
    assert.equal(exploratory.weak, false);
    assert.match(formatSearch(exploratory), /weak\/exploratory/);
    const exact = await routeSearch("redis-patterns", { lexicalOnly: true });
    assert.equal(exact.weak, false);
    assert.equal(exact.hits[0]?.skill.name, "redis-patterns");
  } finally { delete process.env.SKILLROUTER_MIN_RAW; }
  const none = await routeSearch("zzqx unrelated gibberish", { lexicalOnly: true });
  assert.equal(none.hits.length, 0);
  assert.match(formatSearch(none), /^No matching skills/);
});

test("a retired bare name is answered on a read only, with the substitution named; searches and numbered ids never substitute", async () => {
  try {
    const active = built.skills.find((s: any) => s.name === "python-testing")!;
    // The index after a consolidation: the bare name is reserved for an identity that is gone, the skill lives on as ~2.
    const renamed = { ...built, skills: built.skills.map((s: any) => (s === active ? { ...s, id: "python-testing~2", aliases: [] } : s)),
      identityAliases: { ...(built.identityAliases ?? {}), "python-testing": "python-testing@retired000000000000000000", "python-testing~4": "python-testing@retired000000000000000004" } };
    saveIndex(renamed); resetIndexCache();
    // The tombstone holds everywhere but a read: core lists and exact-reference searches do not get another skill.
    assert.equal(findSkill("python-testing").length, 0);
    const search = await routeSearch("python-testing", { lexicalOnly: true });
    assert.ok(!search.decisions.some((d: any) => d.reason === "exact skill reference"), "a retired name is not an exact reference");
    const read = findSkillForRead("Python-Testing");
    assert.deepEqual(read.matches.map((s: any) => s.id), ["python-testing~2"]);
    assert.equal(read.retired, "Python-Testing");
    // A numbered or source-qualified reference names one copy: retired means not found, never a sibling.
    assert.equal(findSkillForRead("python-testing~4").matches.length, 0);
    assert.equal(findSkillForRead("python-testing@retired000000000000000000").matches.length, 0);
    // A live reference is unchanged and carries no note.
    assert.deepEqual(findSkillForRead("python-testing~2"), { matches: findSkill("python-testing~2") });
    // Two active skills of that name: both are named, none is picked silently.
    saveIndex({ ...renamed, skills: [...renamed.skills, { ...active, id: "python-testing~3", stableId: "python-testing@000000000000000000000003", path: active.path + "-other", aliases: [] }] }); resetIndexCache();
    assert.deepEqual(findSkillForRead("python-testing").matches.map((s: any) => s.id).sort(), ["python-testing~2", "python-testing~3"]);
    // A retired name with no skill of that name left still finds nothing.
    saveIndex({ ...built, identityAliases: { ...(built.identityAliases ?? {}), "gone-skill": "gone-skill@retired000000000000000000" } }); resetIndexCache();
    assert.deepEqual(findSkillForRead("gone-skill"), { matches: [] });
    assert.deepEqual(findSkillForRead("never-existed"), { matches: [] });
  } finally { saveIndex(built); resetIndexCache(); }
});

test("a Node path in a versioned or managed folder is recognized as one that will not survive an update", () => {
  for (const p of ["/Users/x/.local/share/vite-plus/js_runtime/node/26.13.1/bin/node", "/Users/x/.nvm/versions/node/v22.4.0/bin/node", "/opt/homebrew/Cellar/node/26.1.0/bin/node",
    "/usr/local/Cellar/node@22/22.1.0_1/bin/node", "/opt/node-v22.4.0-linux-x64/bin/node", "/nix/store/abc-nodejs-22.4.0/bin/node", "/Users/x/.local/share/mise/installs/node/22.4/bin/node",
    "/Users/x/.hermes/node/bin/node", "/opt/hostedtoolcache/node/22.11.0/x64/bin/node", "C:\\Users\\x\\AppData\\Roaming\\nvm\\v20.11.1\\node.exe",
    // Either separator on every OS: a config written on Windows may hold forward slashes, and the reverse.
    "C:/Users/x/.volta/bin/node.exe", "C:\\Users\\x\\.volta\\bin\\node.exe", "/home/x/proj/node_modules/node/bin/node"]) assert.equal(volatileNode(p), true, p);
  for (const p of ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node", "/opt/node22/bin/node", "C:\\Program Files\\nodejs\\node.exe", "C:/Program Files/nodejs/node.exe"]) assert.equal(volatileNode(p), false, p);
});

test("the launcher falls back to another Node when the pinned one is gone", { skip: !posix }, () => {
  const text = launcherScript("/pinned/node", "/x/cli.js", "/x/client.pl", "/x", "/x/sock");
  assert.match(text, /^NODE='\/pinned\/node'$/m);
  assert.match(text, /exec "\$NODE" '\/x\/cli\.js' hint "\$@"/);
  assert.match(text, /for c in "\$\(command -v node 2>\/dev\/null\)" '\/opt\/homebrew\/bin\/node'/, "the Node on PATH is tried before the fixed locations");
  const launcher = path.join(home, "fallback", "bin", "skillrouter-hint");
  const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
  writeLauncher(path.join(home, "no-such-node"), cli, launcher);
  const before = readLog(1).length;
  // The hook still runs (an empty payload is logged as invalid input) because a working Node was found on its own.
  const run = spawnSync(launcher, ["codex"], { input: "{}", encoding: "utf8", env: { ...process.env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH}`, SKILLROUTER_SERVICE: "0" }, timeout: 20000 });
  assert.equal(run.status, 0, run.stderr);
  assert.ok(readLog(1).length > before, "the hook ran and logged");
});

test("install runs a private copy of a checkout's code and switches copies atomically", { skip: !posix }, () => {
  const checkout = path.join(home, "checkout"), src = path.join(checkout, "dist", "src"), sr = path.join(home, "sr-app");
  fs.mkdirSync(src, { recursive: true }); fs.mkdirSync(path.join(checkout, ".git")); fs.mkdirSync(path.join(checkout, "node_modules", "dep"), { recursive: true });
  fs.writeFileSync(path.join(checkout, "package.json"), JSON.stringify({ version: "9.9.9" }));
  fs.writeFileSync(path.join(src, "cli.js"), "export const v = 1;\n"); fs.writeFileSync(path.join(src, "other.js"), "export const o = 1;\n");
  const first = snapshotApp(path.join(src, "cli.js"), sr, "linux");
  assert.equal(first.cli, path.join(sr, "app", "current", "dist", "src", "cli.js"));
  assert.equal(fs.readFileSync(first.cli, "utf8"), "export const v = 1;\n");
  assert.ok(fs.existsSync(path.join(sr, "app", "current", "node_modules", "dep")), "dependencies are reachable from the copy");
  assert.equal(JSON.parse(fs.readFileSync(path.join(sr, "app", "current", "package.json"), "utf8")).version, "9.9.9");
  const firstName = fs.readlinkSync(path.join(sr, "app", "current"));
  assert.match(firstName, /^9\.9\.9-[a-f0-9]{10}$/);
  // A rebuild in the checkout does not reach the installed copy until install runs again.
  fs.writeFileSync(path.join(src, "cli.js"), "export const v = 2;\n");
  assert.equal(fs.readFileSync(first.cli, "utf8"), "export const v = 1;\n");
  const second = snapshotApp(path.join(src, "cli.js"), sr, "linux");
  assert.equal(second.cli, first.cli, "configs keep one path across upgrades");
  assert.equal(fs.readFileSync(second.cli, "utf8"), "export const v = 2;\n");
  assert.notEqual(fs.readlinkSync(path.join(sr, "app", "current")), firstName);
  assert.ok(fs.existsSync(path.join(sr, "app", firstName, ".complete")), "the previous copy is kept for a while");
  // Same code again: the same copy is reused.
  assert.equal(snapshotApp(path.join(src, "cli.js"), sr, "linux").note, second.note);
  // Old copies beyond the newest three go.
  // Older copies are kept two weeks (a long-lived MCP server may run from one), then all but the newest three go.
  for (const v of [3, 4, 5]) { fs.writeFileSync(path.join(src, "cli.js"), `export const v = ${v};\n`); snapshotApp(path.join(src, "cli.js"), sr, "linux"); }
  assert.equal(fs.readdirSync(path.join(sr, "app")).filter((d) => d !== "current").length, 5);
  process.env.SKILLROUTER_SNAPSHOT_KEEP_DAYS = "0";
  try {
    fs.mkdirSync(path.join(sr, "app", "9.9.9-dead000000.tmp-1")); fs.utimesSync(path.join(sr, "app", "9.9.9-dead000000.tmp-1"), new Date(0), new Date(0));
    fs.writeFileSync(path.join(src, "cli.js"), "export const v = 6;\n"); snapshotApp(path.join(src, "cli.js"), sr, "linux");
  } finally { delete process.env.SKILLROUTER_SNAPSHOT_KEEP_DAYS; }
  const kept = fs.readdirSync(path.join(sr, "app")).filter((d) => d !== "current");
  assert.equal(kept.length, 3, kept.join(" "));
  assert.ok(kept.includes(fs.readlinkSync(path.join(sr, "app", "current"))), "the copy in use is never removed");
  assert.ok(!kept.some((d) => /\.tmp-/.test(d)), "the leftover of an install that died is swept");
  // A finished copy of the same code (another install got there first) is reused, not removed and rebuilt.
  const inUse = path.join(sr, "app", fs.readlinkSync(path.join(sr, "app", "current")), ".complete"), stamp = fs.statSync(inUse).mtimeMs;
  snapshotApp(path.join(src, "cli.js"), sr, "linux");
  assert.equal(fs.statSync(inUse).mtimeMs, stamp);
  // A relative state folder still yields absolute paths for the configs.
  const cwd = process.cwd();
  try { process.chdir(home); assert.ok(path.isAbsolute(snapshotApp(path.join(src, "cli.js"), "sr-relative", "linux").cli)); } finally { process.chdir(cwd); }
  // Running from the installed copy, an installed package, Windows, and the switch all leave the code where it is.
  assert.equal(snapshotApp(fs.realpathSync(first.cli), sr, "linux").cli, first.cli);
  fs.rmSync(path.join(checkout, ".git"), { recursive: true });
  assert.equal(snapshotApp(path.join(src, "cli.js"), sr, "linux").cli, path.join(src, "cli.js"));
  fs.mkdirSync(path.join(checkout, ".git"));
  assert.equal(snapshotApp(path.join(src, "cli.js"), sr, "win32").cli, path.join(src, "cli.js"));
  process.env.SKILLROUTER_SNAPSHOT = "0";
  try { assert.equal(snapshotApp(path.join(src, "cli.js"), sr, "linux").cli, path.join(src, "cli.js")); } finally { delete process.env.SKILLROUTER_SNAPSHOT; }
});

test("Hermes profiles get the same Node and code as the main config, and nothing else in them changes", () => {
  const h = path.join(home, "hermes-home"), profile = (n: string) => path.join(h, ".hermes", "profiles", n, "config.yaml");
  const body = (cmd: string, cli: string) => `model: x\nmcp_servers:\n  other:\n    command: /bin/other\n    args:\n      - /other/cli.js\n  skillrouter:\n    command: ${cmd}\n    args:\n      - ${cli}\n      - mcp\n    env:\n      SKILLROUTER_AGENT: hermes\n  after:\n    command: /bin/after\ntail: keep\n`;
  for (const n of ["a", "b"]) { fs.mkdirSync(path.dirname(profile(n)), { recursive: true }); fs.writeFileSync(profile(n), body("/old/versioned/26.1.0/bin/node", "/old/checkout/dist/src/cli.js"), { mode: 0o600 }); }
  fs.mkdirSync(path.dirname(profile("odd")), { recursive: true }); fs.writeFileSync(profile("odd"), "mcp_servers:\n  skillrouter:\n    command: /x/node\n    args: [/x/cli.js, mcp]\n");
  fs.mkdirSync(path.dirname(profile("none")), { recursive: true }); fs.writeFileSync(profile("none"), "model: y\n");
  setInstallCli("/new/app/current/dist/src/cli.js");
  try {
    const note = patchHermesProfiles(h);
    assert.match(note, /2 profiles pointed at the same Node and code/);
    assert.match(note, /left as found \(unrecognized layout\): odd/);
    assert.equal(fs.readFileSync(profile("a"), "utf8"), body(JSON.stringify(NODE), JSON.stringify("/new/app/current/dist/src/cli.js")));
    if (posix) assert.equal(fs.statSync(profile("a")).mode & 0o777, 0o600);
    assert.ok(fs.existsSync(profile("a") + ".bak-skillrouter"));
    assert.equal(fs.readFileSync(profile("none"), "utf8"), "model: y\n");
    assert.match(patchHermesProfiles(h), /2 profiles/); // repeatable
    assert.equal(patchHermesProfiles(path.join(home, "no-hermes")), "");
  } finally { setInstallCli(fileURLToPath(new URL("../src/cli.js", import.meta.url))); }
});

test("the Hermes profile rewrite touches only the skillrouter entry's own command and CLI lines, and is fast on any file", () => {
  const N = "/n/node", C = "/app/current/dist/src/cli.js";
  const patch = (t: string) => hermesProfilePatch(t, N, C);
  const entry = (pad = "  ") => `${pad}skillrouter:\n${pad}  command: /old/node\n${pad}  args:\n${pad}    - /old/dist/src/cli.js\n${pad}    - mcp\n`;
  const want = (pad = "  ") => `${pad}skillrouter:\n${pad}  command: "${N}"\n${pad}  args:\n${pad}    - "${C}"\n${pad}    - mcp\n`;
  // Only block, first, last, between others; a later server's command and cli.js lines are not touched.
  assert.deepEqual(patch(`mcp_servers:\n${entry()}`), { text: `mcp_servers:\n${want()}`, state: "patched" });
  const others = `  after:\n    command: /bin/after\n    args:\n      - /after/dist/src/cli.js\n      - mcp\n`;
  assert.equal(patch(`a: 1\nmcp_servers:\n${entry()}${others}tail: x\n`).text, `a: 1\nmcp_servers:\n${want()}${others}tail: x\n`);
  assert.equal(patch(`mcp_servers:\n${others}${entry()}`).text, `mcp_servers:\n${others}${want()}`);
  // Four-space indents, tabs after the key, quoted values, CRLF, no trailing newline, comments and blank lines inside.
  assert.equal(patch(`mcp_servers:\n${entry("    ")}`).text, `mcp_servers:\n${want("    ")}`);
  assert.equal(patch(`mcp_servers:\r\n  skillrouter:\r\n    command: '/old/node'\r\n    args:\r\n      - "/old/dist/src/cli.js"\r\n      - mcp`).text,
    `mcp_servers:\r\n  skillrouter:\r\n    command: "${N}"\r\n    args:\r\n      - "${C}"\r\n      - mcp`);
  assert.equal(patch(`mcp_servers: # servers\n# a note at column 0\n\n  skillrouter:\n    # pinned by install\n    command: /old/node\n\n    args:\n    - /old/dist/src/cli.js\n    - mcp\n`).state, "patched");
  // A command nested under env, and a list item that merely ends in cli.js before the real one, are not the installer's lines.
  const nested = `mcp_servers:\n  skillrouter:\n    env:\n      command: keep-me\n    command: /old/node\n    args:\n      - /old/dist/src/cli.js\n      - mcp\n`;
  assert.equal(patch(nested).text, nested.replace("command: /old/node", `command: "${N}"`).replace("- /old/dist/src/cli.js", `- "${C}"`));
  assert.equal(patch(`mcp_servers:\n  skillrouter:\n    command: /old/node\n    args:\n      - /hooks/precli.js\n      - /old/dist/src/cli.js\n      - mcp\n`).text,
    `mcp_servers:\n  skillrouter:\n    command: "${N}"\n    args:\n      - /hooks/precli.js\n      - "${C}"\n      - mcp\n`);
  // Two candidates for the CLI line: not guessed.
  assert.equal(patch(`mcp_servers:\n  skillrouter:\n    command: /old/node\n    args:\n      - /a/cli.js\n      - /b/cli.js\n      - mcp\n`).state, "unrecognized");
  // Not the installer's entry: nested under another server, under another top-level key, flow-style args, no args.
  for (const t of [`mcp_servers:\n  wrapper:\n    skillrouter:\n      command: /old/node\n      args:\n        - /old/dist/src/cli.js\n        - mcp\n`,
    `other:\n${entry()}mcp_servers:\n  x:\n    command: y\n`, `mcp_servers: {}\n`, `model: y\n`]) assert.deepEqual(patch(t), { text: t, state: "absent" });
  for (const t of [`mcp_servers:\n  skillrouter:\n    command: /x/node\n    args: [/x/cli.js, mcp]\n`, `mcp_servers:\n  skillrouter:\n    command: /x/node\n`, `mcp_servers:\n  skillrouter:\n`]) assert.deepEqual(patch(t), { text: t, state: "unrecognized" });
  // Already current: nothing to write.
  assert.equal(patch(`mcp_servers:\n${want()}`).state, "current");
  // A large profile without the entry (the case that hung the first version of this code), and one with it last.
  const servers = Array.from({ length: 1500 }, (_v, i) => `  server-${i}:\n    command: /bin/s${i}\n    args:\n      - run\n\n`).join("");
  const t0 = performance.now();
  assert.equal(patch(`mcp_servers:\n${servers}toolsets: [web]\n`).state, "absent");
  assert.equal(patch(`mcp_servers:\n${servers}${entry()}`).state, "patched");
  assert.equal(patch(`mcp_servers:\n${"   \n".repeat(5000)}toolsets: [web]\n`).state, "absent");
  assert.ok(performance.now() - t0 < 2000, `took ${Math.round(performance.now() - t0)} ms`);
});

test("doctor's pin check names a missing or unstable Node and missing code", () => {
  const here = fileURLToPath(new URL("../src/cli.js", import.meta.url));
  const problems = pinProblems([
    { host: "fine", command: process.execPath, args: [here, "mcp"] },
    { host: "gone-node", command: path.join(home, "missing", "node"), args: [here, "mcp"] },
    { host: "gone-code", command: process.execPath, args: [path.join(home, "missing", "cli.js"), "mcp"] },
    { host: "odd-shape", command: 7, args: "/x/cli.js mcp" }, // a hand-edited config: reported on, never crashed on
    { host: "relative", command: process.execPath, args: [".sr/app/current/dist/src/cli.js", "mcp"] },
  ], path.join(home, "no-launcher"));
  assert.ok(problems.some((p: string) => /^relative: code path .* is relative/.test(p)), problems.join("\n"));
  assert.ok(problems.some((p: string) => /^gone-node: Node .* is missing/.test(p)), problems.join("\n"));
  assert.ok(problems.some((p: string) => /^gone-code: code .* is missing/.test(p)), problems.join("\n"));
  assert.ok(!problems.some((p: string) => /^fine: .*missing/.test(p)), problems.join("\n"));
});

test("the report groups repeated empty searches and unknown skill names as gaps", () => {
  const now = new Date().toISOString();
  const s = (query: string, hits: unknown[] = [], agent = "codex", extra: object = {}) => ({ ts: now, client: "x", agent, tool: "search_skills", query, hits, ...extra }) as any;
  const lines = gapLines([
    s("read-only production website integrity verification TLS"), s("production website integrity guard verify TLS certificate"), s("run read-only production website integrity checks", [], "hermes"),
    s("configure xbox controller"), s("python testing", [["python-testing", 1]]),
    ...[1, 2, 3].map(() => ({ ts: now, client: "x", agent: "codex", tool: "read_skill", skill: "prompt-mini", found: false }) as any),
    { ts: now, client: "x", agent: "codex", tool: "read_skill", skill: "once", found: false } as any,
  ]).join("\n");
  assert.match(lines, /Skill gaps/);
  assert.match(lines, /3 {2}codex\+hermes: /);
  assert.doesNotMatch(lines, /xbox/);
  assert.match(lines, /3 {2}prompt-mini/);
  assert.doesNotMatch(lines, /once/);
  assert.deepEqual(gapLines([s("python testing", [["python-testing", 1]])]), []);
  // One shared word, or only filler words, does not make a group; the same one-word query repeated does.
  assert.deepEqual(gapLines([s("review"), s("security review of auth"), s("pull request review etiquette"), s("quarterly performance review template")]), []);
  assert.deepEqual(gapLines([s("The"), s("the best way to cook rice"), s("review the code"), s("the")]), []);
  assert.match(gapLines([s("kubernetes"), s("Kubernetes"), s("kubernetes")]).join("\n"), /3 {2}codex: kubernetes/i);
  // Exploratory and failed searches are not gaps.
  assert.deepEqual(gapLines([1, 2, 3].map(() => s("same empty query here", [], "codex", { exploratory: true })).concat([1, 2, 3].map(() => s("index is missing now", [], "codex", { reason: "index_error" })))), []);
  // 20,000 distinct empty queries: seconds, not minutes (the first version compared every query with every group).
  const many = Array.from({ length: 20000 }, (_v, i) => s(`alpha${i} beta${i % 977} gamma${i % 31} delta`));
  const t0 = performance.now();
  gapLines(many);
  assert.ok(performance.now() - t0 < 5000, `took ${Math.round(performance.now() - t0)} ms`);
});

test("the report's search line separates strong, weak, empty, exploratory and failed searches", () => {
  const now = new Date().toISOString();
  const s = (extra: object) => ({ ts: now, client: "codex-mcp-client/1", agent: "codex", tool: "search_skills", query: "q", ...extra }) as any;
  const text = report(7, [s({ hits: [["a", 1]] }), s({ hits: [["b", 1]], weak: true }), s({ hits: [] }), s({ hits: [["c", 1]], exploratory: true }), s({ hits: [], exploratory: true }), s({ reason: "index_error" })]);
  assert.match(text, /^Searches: 3; 1 with a strong match, 1 with weak candidates only, 1 with nothing \(33%\); plus 2 exploratory; 1 failed \(index unavailable\)\.$/m);
});

test("the usage log rotates past its size limit, keeps a bounded number of archives, and reports read what is kept", () => {
  process.env.SKILLROUTER_LOG_MAX_MB = "0.0005"; // about 500 bytes
  try { for (let i = 0; i < 40; i++) logUsage({ client: "rotation-test", tool: "probe", n: i }); } finally { delete process.env.SKILLROUTER_LOG_MAX_MB; }
  const archives = usageArchives();
  assert.ok(archives.length >= 1 && archives.length <= 8, `${archives.length} archives`);
  // Everything still on disk is read, oldest first, each row once.
  const onDisk = [...archives, path.join(process.env.SKILLROUTER_HOME!, "usage.jsonl")].flatMap((f) => { try { return fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } }).filter((r: any) => r.client === "rotation-test").map((r: any) => r.n);
  const read = readLog(1).filter((r: any) => r.client === "rotation-test").map((r: any) => r.n);
  assert.deepEqual(read, onDisk);
  assert.deepEqual(read, [...read].sort((a: number, b: number) => a - b));
  assert.equal(new Set(read).size, read.length);
  assert.equal(read.at(-1), 39, "the newest row is always there");
  // Rotation off (0), and an empty or unreadable setting meaning the default: nothing rotates at this size.
  const before = usageArchives().length;
  for (const v of ["0", "", "abc"]) { process.env.SKILLROUTER_LOG_MAX_MB = v; try { for (let i = 0; i < 20; i++) logUsage({ client: "rotation-test", tool: "probe", n: 100 + i }); } finally { delete process.env.SKILLROUTER_LOG_MAX_MB; } }
  assert.equal(usageArchives().length, before);
});
