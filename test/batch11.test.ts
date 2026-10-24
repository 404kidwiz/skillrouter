// Routing eval: labeled prompts, metrics, thresholds, the size-scaled lexical floor, and the CLI on the bundled fixture.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "skillrouter-batch11-"));
process.env.HOME = home;
process.env.USERPROFILE = home; // Windows reads this, not HOME, for os.homedir()
process.env.SKILLROUTER_HOME = path.join(home, ".skillrouter");
fs.mkdirSync(process.env.SKILLROUTER_HOME, { recursive: true });
const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const repo = fileURLToPath(new URL("../../", import.meta.url));
const { saveIndex, buildIndexFrom } = await import("../src/index.js");
const { tokenize } = await import("../src/bm25.js");
const { evaluate, readCases, checkThresholds, addCase, DEFAULT_THRESHOLDS } = await import("../src/eval.js");
const { minRawFor } = await import("../src/hint.js");
const { search } = await import("../src/search.js");
process.on("exit", () => fs.rmSync(home, { recursive: true, force: true }));

const skill = (id: string, description: string) => ({ id, name: id, description, path: "/s/" + id, root: "/s", tokens: tokenize(`${id.replace(/-/g, " ")} ${description} `.repeat(3)) });
saveIndex({ builtAt: "e", roots: [], tokenizer: 2, skills: [
  skill("python-testing", "Python testing strategies using pytest: fixtures, mocking, parametrization and coverage. Use when writing or fixing Python tests."),
  skill("toolbox-x-python-testing", "Python testing strategies using pytest: fixtures, mocking, parametrization and coverage. Use when writing or fixing Python tests."),
  skill("docker-patterns", "Docker and Docker Compose patterns for local development: multi-stage builds, compose services, volumes. Use when writing a Dockerfile."),
  ...Array.from({ length: 60 }, (_, i) => skill(`filler-${i}`, `Sourdough proofing and kiln glaze notes number ${i} for hobby pottery and baking enthusiasts.`)),
] } as any);

test("the lexical floor scales with the library's size and honours an absolute override", () => {
  assert.equal(minRawFor(4500), 20);
  assert.equal(minRawFor(450), 14.5);
  assert.ok(minRawFor(2) > 0);
  process.env.SKILLROUTER_MIN_RAW = "12"; assert.equal(minRawFor(4500), 12);
  process.env.SKILLROUTER_MIN_RAW = ""; assert.equal(minRawFor(4500), 20, "empty means the default, not zero");
  delete process.env.SKILLROUTER_MIN_RAW;
});

test("among plain copies the shorter id is named", async () => {
  const hits = await search("pytest fixtures and mocking for python tests", 3, { lexicalOnly: true });
  assert.equal(hits[0].skill.id, "python-testing");
  assert.ok(!hits.some((h) => h.skill.id === "toolbox-x-python-testing"));
});

test("evaluate: metrics per case, copies of an expected skill count, short prompts show nothing", async () => {
  const cases = readCases((() => { const f = path.join(home, "c.jsonl"); fs.writeFileSync(f, [
    JSON.stringify({ prompt: "write pytest tests with fixtures and mocking for the python service", expect: ["toolbox-x-python-testing"] }),
    JSON.stringify({ prompt: "add a Dockerfile with a multi-stage build for the service", expect: ["docker-patterns"] }),
    JSON.stringify({ prompt: "what's the weather today in Paris", expect: [] }),
    JSON.stringify({ prompt: "pytest python tests", expect: [] }), // under 20 characters: the prompt check never searches
    "not json", "", JSON.stringify({ prompt: 5 })].join("\n")); return f; })());
  assert.equal(cases.length, 4, "bad lines are skipped");
  const { rows, summary } = await evaluate(cases, { lexicalOnly: true });
  assert.equal(summary.mode, "lexical");
  assert.deepEqual([summary.positives, summary.negatives], [2, 2]);
  assert.equal(rows[0].top1, true, "the kept copy counts for the expected id");
  assert.equal(rows[1].top1, true);
  assert.equal(rows[2].falseHint, false);
  assert.equal(rows[3].falseHint, false);
  assert.deepEqual([summary.top1, summary.falseHints, summary.copiesShown], [1, 0, 0]);
  // Thresholds judge a summary; this 3-skill index is too small for the precision floor itself to be meaningful.
  assert.deepEqual(checkThresholds({ ...summary, hintPrecision: 1 }), []);
  assert.match(checkThresholds({ ...summary, hintPrecision: 1, top1: 0.5, falseHints: 0.5 }).join("\n"), /top1 50% is below[\s\S]*falseHints 50% is above/);
});

test("eval add labels a prompt for the live set", () => {
  const f = path.join(home, "live.jsonl");
  addCase(f, "merge two pdf files", "pdf, pdf-tools");
  addCase(f, "what time is it", "none");
  assert.deepEqual(readCases(f).map((c) => c.expect), [["pdf", "pdf-tools"], []]);
});

test("the bundled fixture passes the CI gate (what the workflow runs)", () => {
  assert.ok(fs.existsSync(path.join(repo, "eval", "prompts.jsonl")));
  const before = fs.readFileSync(path.join(process.env.SKILLROUTER_HOME!, "index.json"), "utf8");
  const r = spawnSync(process.execPath, [cli, "eval", "--ci"], { env: process.env, encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /Eval \(lexical\): \d+ prompts[\s\S]*PASS/);
  assert.equal(fs.readFileSync(path.join(process.env.SKILLROUTER_HOME!, "index.json"), "utf8"), before, "the fixture run never touches the configured state dir");
  const failing = spawnSync(process.execPath, [cli, "eval", "--ci", "--top1", "1.01"], { env: process.env, encoding: "utf8" });
  assert.equal(failing.status, 1);
  assert.match(failing.stdout, /FAIL/);
});

test("buildIndexFrom indexes only the given folders", () => {
  const root = path.join(home, "corpus"); fs.mkdirSync(path.join(root, "one"), { recursive: true });
  fs.writeFileSync(path.join(root, "one", "SKILL.md"), "---\nname: one\ndescription: The only skill here.\n---\n");
  const idx = buildIndexFrom([root]);
  assert.deepEqual(idx.skills.map((s) => s.id), ["one"]);
  assert.deepEqual(idx.roots, [root]);
  void DEFAULT_THRESHOLDS;
});
