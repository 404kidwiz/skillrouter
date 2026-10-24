// Regression tests for the second QA pass on the skill-effectiveness batch.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "skillrouter-batch4-"));
process.env.HOME = home;
process.env.USERPROFILE = home; // Windows reads this, not HOME, for os.homedir()
process.env.SKILLROUTER_HOME = path.join(home, ".skillrouter");
fs.mkdirSync(process.env.SKILLROUTER_HOME, { recursive: true });
const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const { runHint, selectHints, sessionHash } = await import("../src/hint.js");
const { toolEvent, stopEvent, decisionOf } = await import("../src/events.js");
const { matchTriggers, actionOf } = await import("../src/triggers.js");
const { saveIndex } = await import("../src/index.js");
const { saveVectors, semanticScores } = await import("../src/embed.js");
const { install } = await import("../src/install.js");
const { tokenize } = await import("../src/bm25.js");
const { addShown } = await import("../src/state.js");
const log = path.join(process.env.SKILLROUTER_HOME, "usage.jsonl");
const lastRow = () => JSON.parse(fs.readFileSync(log, "utf8").trim().split("\n").at(-1)!);

const skill = (id: string, description: string) => ({ id, name: id, description, path: `/s/${id}`, root: "/s", tokens: tokenize(`${id} ${description} `.repeat(3)) });
const INDEX_BUILT = "2026-10-23T00:00:00.000Z";
saveIndex({ builtAt: INDEX_BUILT, roots: [], tokenizer: 2, skills: [
  skill("python-testing", "Python testing strategies with pytest fixtures mocking and coverage for writing and fixing tests"),
  skill("docker-patterns", "Docker containers dockerfile images multi-stage builds compose"),
  // Unrelated skills so BM25 term weights look like a real library's.
  ...["seo-audit", "copywriting", "stripe-billing", "figma-handoff", "postgres-tuning", "k8s-deploy"].map((id) => skill(id, `${id.replace("-", " ")} guidance for its own area of work`)),
] } as any);

test("a worker killed after writing its answer keeps that answer (slow model load)", async () => {
  const late = path.join(home, "late.cjs");
  fs.writeFileSync(late, `process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:"UserPromptSubmit",additionalContext:"kept"}}) + "\\n"); setInterval(() => {}, 1000);`);
  const out = await runHint("claude", "{}", late, 300);
  assert.equal(JSON.parse(out).hookSpecificOutput.additionalContext, "kept");
  const partial = path.join(home, "partial.cjs");
  fs.writeFileSync(partial, `process.stdout.write('{"hookSpecific'); setInterval(() => {}, 1000);`);
  assert.equal(await runHint("claude", "{}", partial, 300), "", "a cut-off answer is not passed on");
});

test("vectors built for another index are stale: semantic layer reports it and the lexical gate decides", async () => {
  saveVectors(["python-testing"], [Array(384).fill(0.05)], "some-other-index");
  const r = await semanticScores("pytest", 500, INDEX_BUILT);
  assert.equal(r.status, "stale");
  assert.equal(r.scores, null);
  // A hit with no vector (cos undefined) beside ones with vectors is judged lexically.
  const h = (id: string, raw: number, matched: number, cos?: number) => ({ skill: { id, name: id, description: "Use when doing a specific kind of work", path: "/p", root: "/r", tokens: [] }, score: 1, raw, matched, cos });
  assert.deepEqual(selectHints([h("new-skill", 40, 3), h("vectored", 30, 2, 0.5)], 20, 4).map((x) => x.skill.id).sort(), ["new-skill", "vectored"]);
  assert.deepEqual(selectHints([h("new-weak", 10, 1), h("vectored", 30, 2, 0.5)], 20, 4).map((x) => x.skill.id), ["vectored"]);
});

test("parallel tool hooks fire a rule once; subagents have their own slots and don't steal the parent's", async () => {
  const edit = (agent_id?: string) => JSON.stringify({ session_id: "S1", agent_id, cwd: "/repo", tool_name: "Edit", tool_input: { file_path: "/repo/tests/test_x.py" } });
  const results = await Promise.all([1, 2, 3, 4].map(() => toolEvent("claude", edit(), false)));
  assert.equal(results.filter((r) => typeof r !== "string").length, 1, "exactly one parallel call claims the rule");
  assert.equal(typeof (await toolEvent("claude", edit("sub-1"), false)), "object", "a subagent gets its own slot");
  assert.equal(await toolEvent("claude", edit("sub-1"), false), "");
  // The worker only searches the claimed rules and never sees the tool output.
  const claimedJob = await toolEvent("claude", JSON.stringify({ session_id: "S2", cwd: "/repo", tool_name: "Edit", tool_input: { file_path: "/repo/tests/t.py" }, tool_response: "x".repeat(10) }), false) as { spawn: string };
  assert.deepEqual(JSON.parse(claimedJob.spawn)._claimed, ["tests"]);
  assert.equal(JSON.parse(claimedJob.spawn).tool_response, undefined);
  const out = JSON.parse(await toolEvent("claude", claimedJob.spawn, true) as string).hookSpecificOutput;
  assert.match(out.additionalContext, /before continuing/);
});

test("trigger paths are relative to the session's cwd; tightened rules and wrappers", async () => {
  const ids = (file?: string, command?: string) => matchTriggers(actionOf(file ? "Edit" : "Bash", file ? { file_path: file } : { command })!).map((m) => m.trigger.id);
  assert.deepEqual(ids("notes/Dockerfile-notes.md"), []);
  assert.deepEqual(ids("Dockerfile.prod"), ["docker"]);
  assert.deepEqual(ids("scripts/report.sql"), [], "a .sql file outside migrations is not a migration");
  assert.deepEqual(ids("db/migrations/0007.sql"), ["migration"]);
  for (const c of ["npx prisma migrate dev", "bundle exec rails db:migrate", "uv run alembic upgrade head"]) assert.deepEqual(ids(undefined, c), ["migration"], c);
  for (const c of ["poetry run pytest -q", "make test", "timeout 30 pytest", "./node_modules/.bin/jest", "FOO='x y' pytest", "NODE_ENV=\"a b\" npx vitest run"]) assert.deepEqual(ids(undefined, c), ["tests"], c);
  assert.deepEqual(ids(undefined, "cat <<EOF | docker build -\nFROM node\nEOF"), ["docker"]);
  assert.deepEqual(ids(undefined, "git -C repo rebase main"), ["git-history"]);
  assert.deepEqual(ids(undefined, "tofu plan"), ["terraform"]);
  for (const c of ["git merge-base a b", "git merge-file x y z", "docker compose logs -f", "docker compose ps"]) assert.deepEqual(ids(undefined, c), [], c);
  // Wrappers are whole words: these are commands of their own, not wrapped ones.
  const { commandsOf } = await import("../src/triggers.js");
  assert.deepEqual(commandsOf("envsubst < a > b"), ["envsubst < a > b"]);
  assert.deepEqual(commandsOf("bundle exec rspec"), ["rspec"]);
  assert.deepEqual(commandsOf("execute-thing --x"), ["execute-thing --x"]);
  // Unterminated heredoc with many lines stays fast.
  const t0 = Date.now(); ids(undefined, "cat <<EOF\n" + "\n".repeat(30000)); assert.ok(Date.now() - t0 < 500);
});

const user = (text: string, ts: string, origin?: string) => ({ type: "user", timestamp: ts, origin: origin ? { kind: origin } : undefined, message: { role: "user", content: text } });
const tool = (name: string, input: object = {}) => ({ type: "assistant", message: { content: [{ type: "tool_use", name, input }] } });
const result = () => ({ type: "user", message: { content: [{ type: "tool_result", content: "ok" }] } });
const say = (text: string) => ({ type: "assistant", message: { content: [{ type: "text", text }] } });
function transcript(lines: object[]): string {
  const f = path.join(home, `t-${Math.random()}.jsonl`);
  fs.writeFileSync(f, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return f;
}

test("Stop binds checks to this prompt: a previous turn's hint, a notification turn, or a subagent's trigger never nudge", () => {
  const now = new Date().toISOString();
  const S = sessionHash("S3");
  addShown(S, ["python-testing"], sessionHash("prompt-1"));
  // A subagent's trigger is never recorded as a main-thread check (events.ts records shown checks only without agent_id).
  const work = [user("yes do it", now), tool("Read"), result(), tool("Edit"), result(), tool("Bash"), result(), say("Done.")];
  assert.equal(stopEvent("claude", JSON.stringify({ session_id: "S3", prompt_id: "prompt-2", transcript_path: transcript(work) })), "", "the hint belonged to prompt-1; the trigger to a subagent");
  assert.equal(lastRow().reason, "no_hints");
  assert.equal(JSON.parse(stopEvent("claude", JSON.stringify({ session_id: "S3", prompt_id: "prompt-1", transcript_path: transcript(work) }))).decision, "block");
  // A turn that starts at a notification has no real prompt start in view: never nudged.
  assert.equal(stopEvent("claude", JSON.stringify({ session_id: "S3", prompt_id: "prompt-1", transcript_path: transcript([user("<task-notification>x", now, "task-notification"), tool("Read"), tool("Edit"), tool("Bash")]) })), "");
  assert.equal(lastRow().reason, "no_turn");
});

test("Stop counts loads recorded by the tool hook (turns longer than the transcript tail) and relaxed decision lines", async () => {
  const now = new Date().toISOString();
  const S = sessionHash("S4");
  addShown(S, ["python-testing"], sessionHash("p4"));
  const work = [user("fix the tests", now), tool("Read"), result(), tool("Edit"), result(), tool("Bash"), result(), say("Done.")];
  await toolEvent("claude", JSON.stringify({ session_id: "S4", tool_name: "Skill", tool_input: { skill: "python-testing" } }), false);
  assert.equal(stopEvent("claude", JSON.stringify({ session_id: "S4", prompt_id: "p4", transcript_path: transcript(work) })), "");
  assert.equal(lastRow().reason, "decided");
  for (const t of ["- Skills: none (x)", "Done. Skills: none (plain edit)", "## Skills: python-testing", "**Skills:** python-testing", "`Skills: none (n/a)`"]) assert.ok(decisionOf([t]), t);
  // The protocol line is the capitalised plural; prose and the singular are not decisions.
  for (const t of ["Skills are useful", "skillset: big", "Skills:", "Skill: python-testing", "Design skills: none loaded", "**Total Skills:** 203"]) assert.equal(decisionOf([t]), null, t);
});

test("hint CLI exits promptly after answering and handles large tool payloads", () => {
  const big = JSON.stringify({ session_id: "S5", cwd: "/r", tool_name: "Write", tool_input: { file_path: "/r/src/a.txt", content: "x".repeat(600 * 1024) }, tool_response: { originalFile: "y".repeat(600 * 1024) } });
  const r = spawnSync(process.execPath, [cli, "hint", "claude", "tool"], { input: big, env: process.env, encoding: "utf8", timeout: 5000 });
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), "");
  assert.notEqual(lastRow().reason, "input_too_large");
});

test("install wires PostToolUse and Stop for Claude next to existing hooks", () => {
  const settings = path.join(home, ".claude", "settings.json");
  fs.mkdirSync(path.dirname(settings), { recursive: true });
  fs.writeFileSync(settings, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "echo mine" }] }], PostToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo other" }] }] } }));
  install("claude", home);
  install("claude", home);
  const d = JSON.parse(fs.readFileSync(settings, "utf8")).hooks;
  assert.equal(d.Stop.length, 2);
  assert.equal(d.PostToolUse.length, 2);
  assert.match(JSON.stringify(d.Stop), /echo mine/);
  assert.match(d.PostToolUse[1].matcher, /mcp__\.\*skillrouter__read_skill/);
  assert.match(d.Stop[1].hooks[0].command, /skillrouter-hint(?:\.mjs)?['"] claude stop$/);
});
