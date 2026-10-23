// Precision batch: near-duplicate skills collapse in search, triggers don't repeat this turn's checks,
// and the report groups by agent.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "skillrouter-batch8-"));
process.env.HOME = home;
process.env.SKILLROUTER_HOME = path.join(home, ".skillrouter");
fs.mkdirSync(process.env.SKILLROUTER_HOME, { recursive: true });
const { saveIndex } = await import("../src/index.js");
const { tokenize } = await import("../src/bm25.js");
const { search, nearDuplicate, DUPLICATE_COS } = await import("../src/search.js");
const { toolEvent, triggerPicks } = await import("../src/events.js");
const { sessionHash } = await import("../src/hint.js");
const { addShown, markTurn } = await import("../src/state.js");
const { report, agentOf, readLog } = await import("../src/report.js");
process.on("exit", () => fs.rmSync(home, { recursive: true, force: true }));

const skill = (id: string, description: string, words = description) =>
  ({ id, name: id, description, path: "/s/" + id, root: "/s", tokens: tokenize(`${id.replace(/[-~]/g, " ")} ${words} `.repeat(2)) });
// Filler gives BM25 realistic term rarity, so real matches clear the lexical gates.
const filler = Array.from({ length: 40 }, (_, i) => skill(`filler-${i}`, `Unrelated helper number ${i} for spreadsheets, invoices and calendars`));
saveIndex({ builtAt: "b8", roots: [], tokenizer: 2, skills: [
  skill("qa-only~3", "Report-only QA testing. Systematically tests a web application and produces a structured report with screenshots."),
  skill("toolbox-garrytan-gstack-qa-only-qa-only", "Report-only QA testing. (gstack)", "report only qa testing web application structured report"),
  skill("qa", "Systematically QA test a web application and fix bugs found, committing each fix."),
  skill("python-testing", "Python testing strategies using pytest, fixtures, mocking and tests for python code", "python testing pytest tests writing fixing"),
  skill("pytest-patterns", "Writing and fixing pytest tests in python projects with fixtures", "python testing pytest tests writing fixing"),
  ...filler,
] } as any);

test("near-duplicates: same opening sentence, or skill vectors at the calibrated cosine", () => {
  const a = skill("qa-only", "Report-only QA testing. Long version.");
  const b = skill("toolbox-gstack-qa-only", "Report-only QA testing. (gstack)");
  const c = skill("c", "Systematically QA test a web application.");
  assert.equal(nearDuplicate(a, b, null), true);
  assert.equal(nearDuplicate(a, c, null), false);
  assert.equal(nearDuplicate(skill("d", "Use it. More."), skill("e", "Use it. Other."), null), false, "short shared openings don't count");
  assert.equal(nearDuplicate(skill("cc-skill-continuous-learning", "Development skill from everything-claude-code."), skill("cc-skill-strategic-compact", "Development skill from everything-claude-code."), null), false,
    "a generic 5-word opening on unrelated names is not a copy");
  const unit = (x: number) => [x, Math.sqrt(1 - x * x)];
  const v = { ids: ["qa-only", "c", "x"], dim: 2, data: Float32Array.from([1, 0, ...unit(DUPLICATE_COS + 0.01), ...unit(DUPLICATE_COS - 0.05)]), index: new Map([["qa-only", 0], ["c", 1], ["x", 2]]) };
  assert.equal(nearDuplicate(a, c, v as any), true, "cosine above the threshold");
  assert.equal(nearDuplicate(a, skill("x", "Something else entirely here."), v as any), false, "cosine below the threshold");
});

test("search shows one copy of a duplicated skill and keeps distinct ones", async () => {
  const ids = (await search("report only qa testing web application", 5, { lexicalOnly: true })).map((h) => h.skill.id);
  assert.equal(ids.filter((id) => /qa-only/.test(id)).length, 1, ids.join(", "));
  assert.ok(ids.includes("qa"), "the fixing QA skill is distinct and stays");
});

test("a trigger doesn't repeat a skill this turn's prompt check already showed", async () => {
  const hit = (id: string) => ({ skill: skill(id, "A long enough description for " + id), score: 1, raw: 30, matched: 3 });
  assert.deepEqual(triggerPicks([hit("python-testing"), hit("pytest-patterns")] as any, new Set(), new Set(["python-testing"])).map((h) => h.skill.id), ["pytest-patterns"]);
  const S = sessionHash("B8"), P = sessionHash("p8");
  markTurn(S, P);
  const job = (prompt_id: string) => JSON.stringify({ session_id: "B8", prompt_id, cwd: "/repo", tool_name: "Edit", tool_input: { file_path: "/repo/tests/test_api.py" }, _claimed: ["tests"] });
  const fresh = await toolEvent("claude", job("p-other"), true) as string;
  assert.match(fresh, /python-testing|pytest-patterns/, "baseline: the trigger has something to show");
  addShown(S, ["python-testing", "pytest-patterns"], P);
  assert.equal(await toolEvent("claude", job("p8"), true), "", "everything it would show was shown this turn");
  assert.equal(readLog(1).filter((r) => r.tool === "trigger").at(-1)?.reason, "already_shown");
  const sub = JSON.stringify({ ...JSON.parse(job("p8")), agent_id: "sub-1" });
  assert.notEqual(await toolEvent("claude", sub, true), "", "a subagent never saw the main thread's check");
});

test("report groups by agent, including older rows that only name the MCP client", () => {
  assert.equal(agentOf({ ts: "", tool: "read_skill", client: "codex-mcp-client/0.163.0" } as any), "codex");
  assert.equal(agentOf({ ts: "", tool: "read_skill", client: "claude-code/2.1.308" } as any), "claude");
  assert.equal(agentOf({ ts: "", tool: "read_skill", client: "x", agent: "cursor" } as any), "cursor");
  assert.equal(agentOf({ ts: "", tool: "read_skill", client: "mystery/1" } as any), "mystery", "one row per client, not per version");
  const now = new Date().toISOString();
  const text = report(7, [
    { ts: now, client: "codex-mcp-client/0.163.0", tool: "search_skills" },
    { ts: now, client: "skillrouter", agent: "codex", tool: "read_skill", found: true, skill: "a" },
    { ts: now, client: "hook/gemini", agent: "gemini", tool: "skill_load", via: "activate_skill", skill: "b" },
  ] as any);
  assert.match(text, /By agent \(searches \/ MCP reads \/ native loads\):\n  codex: 1 \/ 1 \/ 0\n  gemini: 0 \/ 0 \/ 1/);
  assert.doesNotMatch(text, /tracked in Claude Code only/);
});
