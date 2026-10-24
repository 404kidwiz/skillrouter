// Regression tests for two false positives seen while dogfooding: a fast-forward merge fired the
// git-history trigger, and a `Skills:` line written mid-turn was missing from Claude Code's transcript.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "skillrouter-batch7-"));
process.env.HOME = home;
process.env.USERPROFILE = home; // Windows reads this, not HOME, for os.homedir()
process.env.SKILLROUTER_HOME = path.join(home, ".skillrouter");
fs.mkdirSync(process.env.SKILLROUTER_HOME, { recursive: true });
const { actionOf, matchTriggers } = await import("../src/triggers.js");
const { hintText, sessionHash } = await import("../src/hint.js");
const { stopEvent } = await import("../src/events.js");
const { addShown } = await import("../src/state.js");
process.on("exit", () => fs.rmSync(home, { recursive: true, force: true }));

const ids = (command: string) => matchTriggers(actionOf("Bash", { command })!).map((m) => m.trigger.id);

test("git-history fires on history rewrites, never on merges", () => {
  for (const c of ["git merge feature", "git merge --ff-only cross-host-triggers", "git -C repo merge x", "git merge --abort", "git pull --rebase=false"])
    assert.deepEqual(ids(c), [], c);
  for (const c of ["git rebase -i HEAD~3", "git cherry-pick abc123", "git bisect start", "git reset --hard HEAD~1", "git -C repo rebase main"])
    assert.deepEqual(ids(c), ["git-history"], c);
  assert.deepEqual(ids("gh pr merge 12"), ["pull-request"], "merging a PR is still pull-request work");
});

test("checks ask for the Skills: line in the final reply too", () => {
  const hit = { skill: { id: "a-skill", name: "a-skill", description: "A skill with a long enough description", path: "/s", root: "/s", tokens: [] }, score: 1, raw: 30, matched: 3 };
  assert.match(hintText([hit] as any, "h", new Set()), /`Skills: none \(<why>\)`\. End your final reply with that line too\./);
  assert.match(hintText([hit] as any, "h", new Set(), "claude", "Skill check (skillrouter): you worked on tests (a.py)."), /your `Skills:` line \(the one that also ends your final reply\)/);
});

test("Claude Stop: a Skills: line in the final reply settles a turn whose mid-turn text the transcript lost", () => {
  const now = new Date().toISOString();
  addShown(sessionHash("S7"), ["git-advanced"], sessionHash("p7"));
  const f = path.join(home, "t.jsonl");
  const tool = (name: string) => ({ type: "assistant", timestamp: now, message: { content: [{ type: "tool_use", name, input: {} }] } });
  fs.writeFileSync(f, [{ type: "user", timestamp: now, message: { role: "user", content: "fast-forward main and push" } }, tool("Bash"), tool("Bash"), tool("Bash")].map((r) => JSON.stringify(r)).join("\n") + "\n");
  const stop = (last: string) => stopEvent("claude", JSON.stringify({ session_id: "S7", prompt_id: "p7", transcript_path: f, last_assistant_message: last }));
  assert.equal(JSON.parse(stop("main is pushed.")).decision, "block", "nothing on record: nudged");
  assert.equal(stop("main is pushed.\n\nSkills: none (a fast-forward needs no git skill)"), "");
});
