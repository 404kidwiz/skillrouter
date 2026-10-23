import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "skillrouter-batch3-"));
process.env.HOME = home;
process.env.SKILLROUTER_HOME = path.join(home, ".skillrouter");
fs.mkdirSync(process.env.SKILLROUTER_HOME, { recursive: true });
const { isSystemText, selectHints, sessionHash } = await import("../src/hint.js");
const { actionOf, matchTriggers, loadTriggers } = await import("../src/triggers.js");
const { toolEvent, stopEvent, currentTurn } = await import("../src/events.js");
const { addShown } = await import("../src/state.js");
const { followsHint, report, readLog } = await import("../src/report.js");
const { saveIndex } = await import("../src/index.js");
const { tokenize } = await import("../src/bm25.js");
const log = path.join(process.env.SKILLROUTER_HOME, "usage.jsonl");
const rows = () => readLog(1);

const skill = (id: string, description: string) => ({ id, name: id, description, path: `/s/${id}`, root: "/s", tokens: tokenize(`${id} ${description} `.repeat(3)) });
saveIndex({ builtAt: new Date().toISOString(), roots: [], tokenizer: 2, skills: [
  skill("python-testing", "Python testing strategies with pytest fixtures mocking and coverage for writing and fixing tests"),
  skill("docker-patterns", "Docker containers dockerfile images multi-stage builds compose"),
  skill("db-migrations", "Database migration schema change best practices and rollbacks"),
] } as any);

test("system-generated turns are never treated as the user's task", () => {
  for (const t of ["<task-notification>\nagent-flow: its hook was skipped", "[SYSTEM NOTIFICATION - NOT USER INPUT]", "Another Claude session sent a message:\n<agent-message from=x>", "<local-command-caveat>x"])
    assert.equal(isSystemText(t), true, t);
  assert.equal(isSystemText("fix the failing pytest in tests/test_auth.py"), false);
});

test("semantic gate: strong meaning passes alone; words need meaning too; junk with matching words is dropped", () => {
  const h = (id: string, raw: number, matched: number, cos: number) => ({ skill: { id, name: id, description: "Use when doing a specific kind of work", path: "/p", root: "/r", tokens: [] }, score: 1, raw, matched, cos });
  const picked = selectHints([h("strong-meaning", 5, 0, 0.6), h("words-and-meaning", 30, 3, 0.31), h("name-collision", 26, 2, 0.12), h("weak", 15, 2, 0.25)], 20, 4).map((x) => x.skill.id);
  assert.deepEqual(picked, ["strong-meaning", "words-and-meaning"]);
  // Without vectors, the lexical gate applies.
  const lex = (id: string, raw: number) => ({ skill: { id, name: id, description: "Use when doing a specific kind of work", path: "/p", root: "/r", tokens: [] }, score: 1, raw, matched: 2 });
  assert.deepEqual(selectHints([lex("a", 30), lex("b", 10)], 20, 4).map((x) => x.skill.id), ["a"]);
});

test("action triggers read files and commands; a user file can disable or add rules", () => {
  const ids = (a: any) => matchTriggers(a).map((m) => m.trigger.id);
  assert.deepEqual(ids(actionOf("Edit", { file_path: "/repo/tests/test_parser.py" })), ["tests"]);
  assert.deepEqual(ids(actionOf("Edit", { file_path: "/repo/tests/test_auth.py" })), ["tests", "auth"]);
  assert.deepEqual(ids(actionOf("Edit", { file_path: "/repo/src/auth/oauth.ts" })), ["auth"]);
  assert.deepEqual(ids(actionOf("Edit", { file_path: "/repo/src/author.ts" })), []);
  assert.deepEqual(ids(actionOf("Write", { file_path: "/repo/Dockerfile" })), ["docker"]);
  assert.deepEqual(ids(actionOf("Edit", { file_path: "/repo/db/migrations/0003_add_index.sql" })), ["migration"]);
  assert.deepEqual(ids(actionOf("Bash", { command: "docker build -t app ." })), ["docker"]);
  assert.deepEqual(ids(actionOf("Bash", { command: "ls -la" })), []);
  // Only commands actually run count: not quoted text, heredoc bodies, or paths that look like commands.
  assert.deepEqual(ids(actionOf("Bash", { command: 'for q in "why is my docker build slow on M1"; do echo "$q"; done' })), []);
  assert.deepEqual(ids(actionOf("Bash", { command: "cat > notes.md <<'EOF'\nrun docker build -t x .\nEOF\nwc -l notes.md" })), []);
  assert.deepEqual(ids(actionOf("Bash", { command: "ls docker-build/ && echo 'git rebase'" })), []);
  assert.deepEqual(ids(actionOf("Bash", { command: "cd app && DOCKER_BUILDKIT=1 docker build -t app ." })), ["docker"]);
  assert.deepEqual(ids(actionOf("Bash", { command: "uv sync; python -m pytest -q tests/" })), ["tests"]);
  assert.deepEqual(ids(actionOf("Bash", { command: "pnpm exec vitest run" })), ["tests"]);
  assert.match(matchTriggers(actionOf("Bash", { command: "cd app && docker build -t app ." })!)[0].subject, /^docker build -t$/);
  assert.equal(actionOf("Read", { file_path: "/x" }), null);
  assert.match(matchTriggers(actionOf("Edit", { file_path: "a/foo.test.ts" })!)[0].query, /typescript/);
  fs.writeFileSync(path.join(process.env.SKILLROUTER_HOME!, "triggers.json"), JSON.stringify([{ id: "frontend", enabled: false }, { id: "proto", label: "edited a protobuf", path: "\\.proto$", query: "protobuf grpc" }]));
  const t = loadTriggers();
  assert.ok(!t.some((x) => x.id === "frontend") && t.some((x) => x.id === "proto"));
  fs.rmSync(path.join(process.env.SKILLROUTER_HOME!, "triggers.json"));
});

test("PostToolUse: native Skill loads are logged with the session; a trigger fires once per session and skips loaded skills", async () => {
  const sid = "session-A";
  assert.equal(await toolEvent("claude", JSON.stringify({ session_id: sid, tool_name: "Skill", tool_input: { skill: "db-migrations" } }), false), "");
  assert.equal(rows().at(-1)?.tool, "skill_load");
  assert.equal(rows().at(-1)?.session, sessionHash(sid));
  const edit = JSON.stringify({ session_id: sid, tool_name: "Edit", tool_input: { file_path: "/repo/tests/test_auth.py" } });
  const job = await toolEvent("claude", edit, false);
  assert.equal(typeof job, "object", "a matching edit is searched in a worker");
  const out = await toolEvent("claude", (job as { spawn: string }).spawn, true) as string;
  const ctx = JSON.parse(out).hookSpecificOutput;
  assert.equal(ctx.hookEventName, "PostToolUse");
  assert.match(ctx.additionalContext, /you worked on tests \(test_auth\.py\)/);
  assert.match(ctx.additionalContext, /python-testing/);
  assert.match(ctx.additionalContext, /before continuing, and include them in your `Skills:` line \(the one that also ends your final reply\)/);
  assert.equal(await toolEvent("claude", edit, false), "", "the same rule does not fire twice in a session");
  // A migration edit fires its own rule, but db-migrations is already loaded in this session.
  const migJob = await toolEvent("claude", JSON.stringify({ session_id: sid, tool_name: "Edit", tool_input: { file_path: "/repo/migrations/1.sql" } }), false) as { spawn: string };
  const mig = await toolEvent("claude", migJob.spawn, true);
  assert.equal(mig, "");
  assert.equal(rows().at(-1)?.reason, "no_match");
});

function transcript(lines: object[]): string {
  const f = path.join(home, `t-${Math.random()}.jsonl`);
  fs.writeFileSync(f, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return f;
}
const user = (text: string, ts: string) => ({ type: "user", timestamp: ts, message: { role: "user", content: text } });
const tool = (name: string, input: object = {}) => ({ type: "assistant", message: { content: [{ type: "tool_use", name, input }] } });
const result = () => ({ type: "user", message: { content: [{ type: "tool_result", content: "ok" }] } });
const say = (text: string) => ({ type: "assistant", message: { content: [{ type: "text", text }] } });

test("Stop: nudges once when hints went undecided on a working turn, never otherwise", () => {
  const sid = "session-B";
  const now = new Date().toISOString();
  addShown(sessionHash(sid), ["python-testing"]); // what the prompt hook records when it shows a check
  const working = [user("earlier prompt", now), say("old"), user("fix the tests", now), tool("Read"), result(), tool("Edit"), result(), tool("Bash"), result(), say("Done.")];
  const blocked = JSON.parse(stopEvent("claude", JSON.stringify({ session_id: sid, transcript_path: transcript(working), stop_hook_active: false })));
  assert.equal(blocked.decision, "block");
  assert.match(blocked.reason, /python-testing/);
  assert.equal(rows().at(-1)?.reason, "nudged");
  assert.equal(stopEvent("claude", JSON.stringify({ session_id: sid, transcript_path: transcript(working), stop_hook_active: true })), "");
  assert.equal(stopEvent("claude", JSON.stringify({ session_id: sid, transcript_path: transcript([...working.slice(0, 3), say("Skills: none (plain refactor)"), ...working.slice(3)]) })), "");
  assert.equal(rows().at(-1)?.reason, "decided");
  assert.equal(stopEvent("claude", JSON.stringify({ session_id: sid, transcript_path: transcript([...working.slice(0, 3), tool("Skill", { skill: "python-testing" }), ...working.slice(3)]) })), "");
  assert.equal(stopEvent("claude", JSON.stringify({ session_id: sid, transcript_path: transcript([user("fix it", now), tool("Read"), say("ok")]) })), "");
  assert.equal(rows().at(-1)?.reason, "trivial");
  assert.equal(stopEvent("claude", JSON.stringify({ session_id: "no-hints", transcript_path: transcript(working) })), "");
  assert.equal(rows().at(-1)?.reason, "no_hints");
  // The turn starts at the last real prompt, not at a tool result.
  assert.equal(currentTurn(transcript(working))?.toolCalls, 3);
});

test("report credits a hint followed by a native Skill load in the same session", () => {
  const t0 = new Date().toISOString();
  const t1 = new Date(Date.now() + 1000).toISOString();
  const hint = { ts: t0, client: "hook/claude", tool: "hint", agent: "claude", session: "S", hint_id: "x", reason: "shown", hits: [["impeccable", 1] as [string, number]] };
  const load = { ts: t1, client: "hook/claude", tool: "skill_load", via: "Skill", agent: "claude", session: "S", skill: "impeccable" };
  assert.equal(followsHint(hint, load), true);
  assert.equal(followsHint(hint, { ...load, session: "other" }), false);
  const text = report(1, [hint, load, { ts: t1, client: "hook/claude", tool: "decision", reason: "decided", session: "S" }]);
  assert.match(text, /1 native skill loads/);
  assert.match(text, /1\/1 shown hints have a correlated organic successful load/);
  assert.match(text, /1 decided/);
});
