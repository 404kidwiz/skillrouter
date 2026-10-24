// Hint precision (2026-10-24): specific words, conversational prompts, the tighter gate, the real-path package import,
// and the diagnostics that show whether the semantic layer actually ran.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "skillrouter-b15-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.SKILLROUTER_HOME = path.join(home, ".skillrouter");
const { BM25, tokenize, SPECIFIC_DF } = await import("../src/bm25.js");
const { isConversational, isSystemText, selectHints } = await import("../src/hint.js");
const { packageEntry } = await import("../src/embed.js");
const { semanticLine } = await import("../src/health.js");
const { report } = await import("../src/report.js");
const { evaluate } = await import("../src/eval.js");
const { saveIndex } = await import("../src/index.js");

const doc = (id: string, text: string) => ({ id, tokens: tokenize(text), name: tokenize(id) });

test("BM25 counts the matched words that are rare in the library, not the ones every skill uses", () => {
  const docs = [doc("pdf-tools", "Edit PDF files, merge and split documents. Use when the user has a pdf"), doc("docx-tools", "Edit Word documents. Use when the user has a docx"),
    ...Array.from({ length: 60 }, (_, i) => doc(`helper-${i}`, `Use when the user wants to edit a file number ${i}`))];
  const bm = new BM25(docs);
  assert.equal(bm.isSpecific("pdf"), true); assert.equal(bm.isSpecific("edit"), false, "'edit' is in every skill"); assert.equal(bm.isSpecific("user"), false);
  const [top] = bm.search("edit the pdf the user sent", 3);
  assert.equal(top.id, "pdf-tools");
  assert.equal(top.matched, 3, "edit, pdf and user match");
  assert.equal(top.specific, 1, "only pdf names a topic");
  assert.ok(SPECIFIC_DF > 0 && SPECIFIC_DF < 0.1);
  // A tiny library: a word found in one skill is specific even though one skill is well over 2% of it.
  const tiny = new BM25([doc("docker-patterns", "Dockerfile multi-stage builds"), doc("python-testing", "pytest fixtures mocking"), doc("writing-plans", "plan features")]);
  assert.equal(tiny.search("add a Dockerfile with a multi-stage build", 1)[0].specific, 4, "dockerfile, multi, stage, build: each in one skill");
});

test("conversational prompts point at the conversation, not at work", () => {
  for (const p of ["What's next? Any suggestions?", "ok, continue", "Let's move forward with all of your recommendations 1 through 5, verify with a QA agent", "Do suggestions 1 and 3: don't re-suggest skills already shown",
    "Yes, build Windows stage 2 the same way", "Fix both: stop the trigger firing on merges and change the wording", "go ahead and implement step 2", "sounds good, do it",
    "What is next? Do you have any suggestions for improvements before moving forward?", "Are there any suggestions for enhancements before closing out?", "what are next steps", "proceeding with option B"])
    assert.equal(isConversational(p), true, p);
  for (const p of ["write pytest tests for the api client and fix the failing fixtures", "why is my docker build slow on M1", "add a GitHub Actions workflow that runs the tests on push", "merge two pdf files and extract the tables", "How do I rebase my branch onto main and keep my hooks?"])
    assert.equal(isConversational(p), false, p);
  assert.equal(isSystemText("# Files mentioned by the user:\n## shot.png: /tmp/shot.png"), true, "a host's attachment preamble is not the user's task");
});

test("the gate: meaning alone, meaning plus specific words, nothing on a conversational prompt without unmistakable meaning", () => {
  const h = (id: string, raw: number, matched: number, specific: number, cos?: number) => ({ skill: { id, name: id, description: "Use when doing a specific kind of work", path: "/p", root: "/r", tokens: [] }, score: 1, raw, matched, specific, cos });
  const ids = (hits: ReturnType<typeof h>[], o?: { conversational?: boolean }) => selectHints(hits, 20, 3, o).map((x) => x.skill.id);
  assert.deepEqual(ids([h("meaning", 10, 1, 0, 0.52), h("words-generic", 45, 6, 1, 0.42), h("words-specific", 45, 6, 2, 0.42), h("words-only", 60, 8, 3, 0.3)]), ["meaning", "words-specific"],
    "generic words at 0.42 are a collision; specific ones with the same meaning pass; words alone never do");
  assert.deepEqual(ids([h("meaning", 10, 1, 0, 0.52), h("words-specific", 45, 6, 2, 0.42)], { conversational: true }), [], "'do suggestion 2' style prompts: 0.52 is not unmistakable");
  assert.deepEqual(ids([h("sure", 30, 3, 2, 0.6), h("words-specific", 45, 6, 2, 0.42)], { conversational: true }), ["sure"]);
  assert.deepEqual(ids([h("best", 10, 1, 0, 0.7), h("near", 10, 1, 0, 0.6), h("far", 10, 1, 0, 0.5)]), ["best", "near"], "a candidate more than 0.12 under the best is left out");
  assert.deepEqual(ids([h("a", 10, 1, 0, 0.7), h("b", 10, 1, 0, 0.69), h("c", 10, 1, 0, 0.68), h("d", 10, 1, 0, 0.67)]).length, 3, "at most three");
  // Lexical only (no vectors anywhere): the floor, two words, one of them specific; nothing on a conversational prompt.
  assert.deepEqual(ids([h("specific", 30, 2, 1), h("generic", 40, 3, 0), h("low", 10, 2, 2)]), ["specific"]);
  assert.deepEqual(ids([h("specific", 30, 2, 1)], { conversational: true }), []);
  // A hit without a vector among vectored ones is judged by the lexical rule.
  assert.deepEqual(ids([h("vectored", 10, 1, 0, 0.55), h("new-skill", 30, 3, 2)]).sort(), ["new-skill", "vectored"]);
});

test("the eval applies the same gate as the hook, so its numbers mean what the hook does", async () => {
  const lib = path.join(home, "lib");
  for (const [id, text] of [["docker-patterns", "Dockerfile and compose best practices, multi-stage builds"], ["python-testing", "Write pytest tests with fixtures and mocking"], ["writing-plans", "Turn a feature idea into a step by step plan"]] as const) {
    fs.mkdirSync(path.join(lib, id), { recursive: true }); fs.writeFileSync(path.join(lib, id, "SKILL.md"), `---\nname: ${id}\ndescription: ${text}\n---\n`);
  }
  const { buildIndex } = await import("../src/index.js");
  saveIndex(buildIndex([lib]));
  const { summary, rows } = await evaluate([
    { prompt: "add a Dockerfile with a multi-stage build for the service", expect: ["docker-patterns"] },
    { prompt: "ok go ahead and build the Dockerfile the way you suggested", expect: [] }, // conversational: the words match, the hook shows nothing
  ], { lexicalOnly: true });
  assert.equal(rows[0].recall, true);
  assert.equal(rows[1].falseHint, false);
  assert.equal(summary.falseHints, 0);
});

test("a package reached through a link is imported by its real path, where its own dependencies are", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sr-pkg-"));
  const store = path.join(root, "store", "node_modules"), project = path.join(root, "project", "node_modules");
  fs.mkdirSync(path.join(store, "sr-fake-dep"), { recursive: true }); fs.mkdirSync(path.join(store, "sr-fake-pkg", "dist"), { recursive: true }); fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(store, "sr-fake-dep", "package.json"), JSON.stringify({ name: "sr-fake-dep", type: "module", exports: "./index.js" }));
  fs.writeFileSync(path.join(store, "sr-fake-dep", "index.js"), "export const dep = 'ok';");
  fs.writeFileSync(path.join(store, "sr-fake-pkg", "package.json"), JSON.stringify({ name: "sr-fake-pkg", type: "module", exports: { ".": { node: { import: "./dist/main.js", require: "./dist/main.cjs" }, default: "./dist/main.js" } } }));
  fs.writeFileSync(path.join(store, "sr-fake-pkg", "dist", "main.js"), "export { dep } from 'sr-fake-dep';");
  fs.writeFileSync(path.join(store, "sr-fake-pkg", "dist", "main.cjs"), "module.exports = {};");
  fs.symlinkSync(path.join(store, "sr-fake-pkg"), path.join(project, "sr-fake-pkg"), process.platform === "win32" ? "junction" : "dir");
  const from = pathToFileURL(path.join(root, "project", "src", "x.js")).href;
  const entry = packageEntry("sr-fake-pkg", from);
  assert.equal(entry, pathToFileURL(fs.realpathSync(path.join(store, "sr-fake-pkg", "dist", "main.js"))).href, "the node import entry, under the real path");
  assert.throws(() => packageEntry("sr-missing-pkg", from), /Cannot find|not found/);
});

test("doctor and report say whether the semantic layer really ran in prompt checks", () => {
  const rows: any[] = [
    ...Array.from({ length: 8 }, (_, i) => ({ ts: new Date().toISOString(), client: "hook/claude", agent: "claude", tool: "hint", reason: "shown", sem: "error", sem_error: "Cannot find package 'onnxruntime-common'", hits: [[`s${i}`, 1, 30, null]] })),
    { ts: new Date().toISOString(), client: "hook/claude", agent: "claude", tool: "hint", reason: "no_match", sem: "on", hits: [] },
    { ts: new Date().toISOString(), client: "hook/claude", agent: "claude", tool: "hint", reason: "skipped_short_prompt", hits: [] },
  ];
  const line = semanticLine(rows);
  assert.match(line, /error 8, on 1/); assert.match(line, /fell back to BM25/); assert.match(line, /onnxruntime-common/);
  assert.match(semanticLine([]), /no prompt checks/);
  const r = report(7, rows);
  assert.match(r, /Prompt checks: 8\/9 showed a hint/); assert.match(r, /Semantic layer during those checks: error 8, on 1 \(mostly BM25 alone/);
});

test("a skill a host keeps accepting is endorsed, and passes the hint gate on a lower bar", async () => {
  const { addVerdict, endorsed, readVerdicts } = await import("../src/verdicts.js");
  for (let i = 0; i < 3; i++) addVerdict("codex", ["qa-only~2"], ["klaviyo-automation"]);
  addVerdict("codex", [], ["qa-only"]); // one decline: still accepted 3 of 4 times
  addVerdict("claude", ["qa-only"], []); // another host: its own history
  const v = readVerdicts();
  assert.deepEqual([...endorsed("codex", v)], ["qa-only"], "three accepted turns, at least half the time");
  assert.deepEqual([...endorsed("claude", v)], [], "one acceptance is not a habit");
  addVerdict("codex", [], ["qa-only"]); addVerdict("codex", [], ["qa-only"]); addVerdict("codex", [], ["qa-only"]);
  assert.deepEqual([...endorsed("codex", readVerdicts())], [], "accepted 3 of 7 now: under half, the bar is back to normal");
  process.env.SKILLROUTER_ENDORSE_AFTER = "0";
  assert.deepEqual([...endorsed("codex", v)], [], "0 turns it off");
  delete process.env.SKILLROUTER_ENDORSE_AFTER;

  const h = (id: string, raw: number, matched: number, specific: number, cos?: number) => ({ skill: { id, name: id, description: "Use when doing a specific kind of work", path: "/p", root: "/r", tokens: [] }, score: 1, raw, matched, specific, cos });
  const ids = (hits: ReturnType<typeof h>[], o?: { conversational?: boolean; trusted?: Set<string> }) => selectHints(hits, 20, 3, o).map((x) => x.skill.id);
  const automation = [h("klaviyo-automation", 49, 8, 3, 0.38), h("qa-only~2", 43, 8, 2, 0.24), h("sdk", 34, 9, 0, 0.28)]; // the real Site Integrity Guard prompt, as scored
  assert.deepEqual(ids(automation), [], "unknown skills: nothing confident enough");
  assert.deepEqual(ids(automation, { trusted: new Set(["qa-only"]) }), ["qa-only~2"], "the skill this host keeps accepting comes back; the junk does not");
  assert.deepEqual(ids([h("best", 10, 1, 0, 0.7), h("habit", 10, 1, 0, 0.42)], { trusted: new Set(["habit"]) }), ["best", "habit"], "an endorsed skill is not held to the margin");
  assert.deepEqual(ids([h("habit", 10, 1, 0, 0.42)], { conversational: true, trusted: new Set(["habit"]) }), [], "but 'do suggestion 2' still needs 0.45 even from it");
  assert.deepEqual(ids([h("habit", 30, 2, 0)], { trusted: new Set(["habit"]) }), ["habit"], "lexical only: no specific word needed from an endorsed skill");
});
