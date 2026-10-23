// Regression tests for the re-verification pass.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const home = fs.mkdtempSync(path.join(os.tmpdir(), "skillrouter-batch5-"));
process.env.HOME = home;
process.env.SKILLROUTER_HOME = path.join(home, ".skillrouter");
fs.mkdirSync(process.env.SKILLROUTER_HOME, { recursive: true });
const { matchTriggers, actionOf, commandsOf } = await import("../src/triggers.js");
const { toolEvent, stopEvent } = await import("../src/events.js");
const { sessionHash } = await import("../src/hint.js");
const { addShown, addLoaded, claim } = await import("../src/state.js");
const { followsHint } = await import("../src/report.js");
const { saveIndex } = await import("../src/index.js");
const { tokenize } = await import("../src/bm25.js");
const ids = (command) => matchTriggers(actionOf("Bash", { command })).map((m) => m.trigger.id);
test("package-manager scripts are commands, not wrappers", () => {
    for (const c of ["pnpm test", "pnpm run test", "pnpm -r test", "pnpm --filter web test", "yarn test", "bun test", "bun run test", "npm test"])
        assert.deepEqual(ids(c), ["tests"], c);
    for (const c of ["pnpm publish", "yarn publish", "npm publish --access public"])
        assert.deepEqual(ids(c), ["release"], c);
    assert.deepEqual(ids("pnpm exec vitest run"), ["tests"]);
    assert.deepEqual(ids("pnpm install"), []);
});
test("shell keywords and wrappers before a command; multi-line quotes and here-strings", () => {
    for (const c of ["for f in a b; do pytest $f; done", "if true; then docker build .; fi", "nice -n 5 pytest", "command docker build ."])
        assert.equal(ids(c).length, 1, c);
    assert.deepEqual(ids('git commit -m "first line\ndocker build . is mentioned here"'), []);
    assert.deepEqual(commandsOf("grep x <<< \"$var\"\ndocker build ."), ["grep x <<< Q", "docker build ."]);
    // Many unterminated heredoc openers stay linear.
    const t0 = Date.now();
    commandsOf("<<A\n".repeat(16000));
    assert.ok(Date.now() - t0 < 300, `took ${Date.now() - t0} ms`);
});
test("only the claimed rules are used up; no session or no index never claims", async () => {
    saveIndex({ builtAt: "x", roots: [], tokenizer: 2, skills: [
            { id: "python-testing", name: "python-testing", description: "Python testing with pytest fixtures and mocking for tests", path: "/s", root: "/s", tokens: tokenize("python testing pytest tests ".repeat(3)) },
        ] });
    const edit = (session_id, file) => JSON.stringify({ session_id, cwd: "/repo", tool_name: "Edit", tool_input: { file_path: file } });
    // tests + frontend + auth match; only the first two are claimed, auth stays available.
    const job = await toolEvent("claude", edit("S1", "/repo/src/auth/login.test.tsx"), false);
    assert.deepEqual(JSON.parse(job.spawn)._claimed, ["tests", "frontend"]);
    assert.equal(claim(sessionHash("S1"), "auth"), true, "auth was not used up");
    assert.equal(await toolEvent("claude", edit(undefined, "/repo/tests/a.py"), false), "", "no session: nothing to dedupe against, never fires");
    fs.rmSync(path.join(process.env.SKILLROUTER_HOME, "index.json"));
    assert.equal(await toolEvent("claude", edit("S9", "/repo/tests/a.py"), false), "", "no index: never claims");
    assert.equal(claim(sessionHash("S9"), "tests"), true, "the rule is still available once an index exists");
});
const user = (text, ts) => ({ type: "user", timestamp: ts, message: { role: "user", content: text } });
const tool = (name) => ({ type: "assistant", message: { content: [{ type: "tool_use", name, input: {} }] } });
function transcript(lines) {
    const f = path.join(home, `t-${Math.random()}.jsonl`);
    fs.writeFileSync(f, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    return f;
}
test("Stop reads shown checks from the session's own state, unaffected by other sessions' log volume", () => {
    const now = new Date().toISOString();
    const S = sessionHash("S5");
    addShown(S, ["python-testing"], sessionHash("p5"));
    fs.appendFileSync(path.join(process.env.SKILLROUTER_HOME, "usage.jsonl"), (JSON.stringify({ ts: now, client: "x", tool: "hint", session: "other", reason: "shown", hits: [["y", 1]] }) + "\n").repeat(3000));
    const work = transcript([user("fix the tests", now), tool("Read"), tool("Edit"), tool("Bash")]);
    assert.equal(JSON.parse(stopEvent("claude", JSON.stringify({ session_id: "S5", prompt_id: "p5", transcript_path: work }))).decision, "block");
    addLoaded(S, "python-testing");
    assert.equal(stopEvent("claude", JSON.stringify({ session_id: "S5", prompt_id: "p5", transcript_path: work })), "");
});
test("state dirs are touched on every write, so pruning never drops an active session", () => {
    const S = sessionHash("S6");
    addLoaded(S, "a");
    const dir = path.join(process.env.SKILLROUTER_HOME, "state", S);
    const old = new Date(Date.now() - 9 * 86400e3);
    fs.utimesSync(dir, old, old);
    addLoaded(S, "b");
    assert.ok(Date.now() - fs.statSync(dir).mtimeMs < 60_000);
    claim(sessionHash("brand-new-session"), "tests"); // creating a session prunes others
    assert.ok(fs.existsSync(dir), "the active session survived the prune");
});
test("a subagent's load does not credit the main thread's check", () => {
    const t0 = new Date().toISOString(), t1 = new Date(Date.now() + 1000).toISOString();
    const hint = { ts: t0, client: "hook/claude", tool: "hint", agent: "claude", session: "S", hits: [["x", 1]] };
    const load = { ts: t1, client: "hook/claude", tool: "skill_load", agent: "claude", session: "S", skill: "x" };
    assert.equal(followsHint(hint, load), true);
    assert.equal(followsHint(hint, { ...load, sub: "subagent" }), false);
});
