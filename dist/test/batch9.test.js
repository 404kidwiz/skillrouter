// QA fixes for the precision batch: siblings are named not hidden, shown/loaded skills anchor their
// clusters, core copies win, two rules in one call don't repeat, and a rule with nothing new rests one turn.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
const home = fs.mkdtempSync(path.join(os.tmpdir(), "skillrouter-batch9-"));
process.env.HOME = home;
process.env.SKILLROUTER_HOME = path.join(home, ".skillrouter");
fs.mkdirSync(process.env.SKILLROUTER_HOME, { recursive: true });
const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const { saveIndex } = await import("../src/index.js");
const { tokenize } = await import("../src/bm25.js");
const { saveVectors } = await import("../src/embed.js");
const { search } = await import("../src/search.js");
const { coreIds } = await import("../src/core.js");
const { toolEvent } = await import("../src/events.js");
const { sessionHash } = await import("../src/hint.js");
const { addShown, markTurn } = await import("../src/state.js");
const { readLog } = await import("../src/report.js");
process.on("exit", () => fs.rmSync(home, { recursive: true, force: true }));
const skill = (id, description, words = description) => ({ id, name: id, description, path: "/s/" + id, root: "/s", tokens: tokenize(`${id.replace(/[-~]/g, " ")} ${words} `.repeat(2)) });
const filler = Array.from({ length: 40 }, (_, i) => skill(`filler-${i}`, `Unrelated helper number ${i} for spreadsheets, invoices and calendars`));
const skills = [
    skill("gws-gmail-reply", "Reply to a Gmail message from the command line with gws.", "gmail reply message email send"),
    skill("gws-gmail-reply-all", "Reply-all to a Gmail thread from the command line with gws.", "gmail reply all message email send"),
    skill("toolbox-x-design-taste-frontend", "Anti-slop design skill for greenfield pages, audits and redesigns of frontends.", "design taste frontend pages audits redesigns greenfield slop design"),
    { ...skill("design-taste-frontend~2", "Anti-slop design skill for greenfield pages, audits and redesigns of frontends.", "design taste frontend"), name: "design-taste-frontend" },
    skill("python-testing", "Python testing strategies using pytest with fixtures and mocking for every python test suite.", "python testing pytest tests writing fixing"),
    skill("pytest-patterns", "Python testing strategies using pytest with fixtures and mocking for every python test suite.", "pytest tests python writing fixing"),
    skill("auth-and-tests", "Authentication and authorization security checks with python pytest tests.", "authentication authorization security python pytest tests writing fixing"),
    // Same name, different text: the claude-api~2 variant has a toolbox copy that must not show beside claude-api.
    skill("claude-api", "Build apps with the Claude API and the Anthropic SDK.", "claude api anthropic sdk tool use"),
    { ...skill("claude-api~2", "Claude API reference for messages, streaming and tool use in every SDK language.", "claude api sdk tool use messages streaming"), name: "claude-api" },
    skill("toolbox-z-claude-api-claude-api", "Claude API reference for messages, streaming and tool use in every SDK language.", "claude api sdk tool use messages streaming reference"),
    // An exact core id and a same-named variant with someone else's text.
    skill("impeccable", "Design, critique and polish frontend interfaces with an opinionated taste system.", "impeccable design polish critique"),
    { ...skill("impeccable~3", "Create distinctive production-grade frontend interfaces with high design quality and bold aesthetics.", "distinctive production grade frontend interfaces design quality"), name: "impeccable" },
    skill("frontend-design~2", "Create distinctive production-grade frontend interfaces with high design quality and bold aesthetics.", "distinctive production grade frontend interfaces design quality bold aesthetics"),
    ...filler,
];
const builtAt = "b9";
saveIndex({ builtAt, roots: [], tokenizer: 2, skills });
// Stand-in vectors: one axis per skill (cosine 0 between skills), except the gmail siblings at cosine 0.98.
const axis = (i) => skills.map((_, j) => (i === j ? 1 : 0));
const nearReply = skills.map((_, j) => (j === 0 ? 0.98 : j === 1 ? Math.sqrt(1 - 0.98 ** 2) : 0));
saveVectors(skills.map((s) => s.id), skills.map((s, i) => (s.id === "gws-gmail-reply-all" ? nearReply : axis(i))), builtAt);
test("a sibling folded in by meaning is named on the kept hit, not hidden", async () => {
    const hits = await search("reply to a gmail message", 5, { lexicalOnly: true });
    const top = hits.find((h) => h.skill.id.startsWith("gws-gmail-reply"));
    assert.equal(hits.filter((h) => h.skill.id.startsWith("gws-gmail-reply")).length, 1);
    assert.deepEqual(top.similar, [top.skill.id === "gws-gmail-reply" ? "gws-gmail-reply-all" : "gws-gmail-reply"]);
});
test("vectors built for another index are not used to collapse (CLI end to end)", () => {
    const run = (meta) => {
        const f = path.join(process.env.SKILLROUTER_HOME, "embeddings.json");
        const m = JSON.parse(fs.readFileSync(f, "utf8"));
        meta(m);
        fs.writeFileSync(f, JSON.stringify(m));
        return spawnSync(process.execPath, [cli, "search", "reply to a gmail message", "-k", "5"], { env: process.env, encoding: "utf8" }).stdout;
    };
    assert.match(run(() => { }), /\[similar: gws-gmail-reply/);
    const stale = run((m) => { m.indexBuiltAt = "another-index"; });
    assert.doesNotMatch(stale, /similar/);
    assert.match(stale, /gws-gmail-reply-all/, "without fresh vectors both siblings are listed");
    run((m) => { m.indexBuiltAt = builtAt; });
});
test("a preloaded core copy takes its cluster's slot from a higher-ranked copy", async () => {
    const query = "anti slop design taste frontend greenfield pages audits redesigns";
    assert.equal((await search(query, 3, { lexicalOnly: true }))[0].skill.id, "toolbox-x-design-taste-frontend", "baseline: the toolbox copy ranks first");
    const base = (await search(query, 3, { lexicalOnly: true }))[0];
    const hits = await search(query, 3, { lexicalOnly: true, prefer: coreIds(["design-taste-frontend"]) });
    assert.equal(hits[0].skill.id, "design-taste-frontend~2", "core.txt names the skill; with no exact id, its variants count");
    assert.equal(hits.filter((h) => /design-taste-frontend/.test(h.skill.id)).length, 1);
    assert.equal(hits[0].score, base.score, "the cluster keeps its rank and metrics when the preloaded copy takes the slot");
    assert.equal(hits[0].raw, base.raw);
});
test("a shown or loaded skill anchors its cluster: its copies are left out too", async () => {
    const hits = await search("python testing pytest fixtures", 5, { lexicalOnly: true, known: new Set(["pytest-patterns"]) });
    assert.ok(!hits.some((h) => h.skill.id === "python-testing" || h.skill.id === "pytest-patterns"), hits.map((h) => h.skill.id).join(", "));
});
const edit = (session_id, prompt_id, file, extra = {}) => JSON.stringify({ session_id, prompt_id, cwd: "/repo", tool_name: "Edit", tool_input: { file_path: file }, ...extra });
test("two rules fired by one edit don't recommend the same skill twice", async () => {
    markTurn(sessionHash("TWO"), sessionHash("p2"));
    const out = await toolEvent("claude", JSON.stringify({ ...JSON.parse(edit("TWO", "p2", "/repo/tests/test_auth.py")), _claimed: ["tests", "auth"] }), true);
    const text = JSON.parse(out).hookSpecificOutput.additionalContext;
    const ids = [...text.matchAll(/^- (\S+) —/gm)].map((m) => m[1]);
    assert.ok(ids.length >= 2, text);
    assert.equal(new Set(ids).size, ids.length, `repeated: ${ids.join(", ")}`);
});
test("a rule with nothing new rests for the turn, then fires again next turn", async () => {
    const S = sessionHash("REST");
    markTurn(S, sessionHash("t1"));
    addShown(S, ["python-testing", "pytest-patterns", "auth-and-tests"], sessionHash("t1"));
    const first = await toolEvent("claude", edit("REST", "t1", "/repo/tests/test_a.py"), false);
    assert.deepEqual(JSON.parse(first.spawn)._claimed, ["tests"]);
    assert.equal(await toolEvent("claude", first.spawn, true), "");
    assert.equal(readLog(1).filter((r) => r.tool === "trigger").at(-1)?.reason, "already_shown");
    assert.equal(await toolEvent("claude", edit("REST", "t1", "/repo/tests/test_b.py"), false), "", "same turn: no new worker");
    await new Promise((r) => setTimeout(r, 5));
    markTurn(S, sessionHash("t2"));
    const next = await toolEvent("claude", edit("REST", "t2", "/repo/tests/test_c.py"), false);
    assert.equal(typeof next, "object", "next turn: the rule is available again");
});
test("second QA pass: copy-only anchors, same-name variant groups, exact core ids", async () => {
    const afterReply = await search("reply all to a gmail thread", 5, { lexicalOnly: true, known: new Set(["gws-gmail-reply"]) });
    assert.ok(afterReply.some((h) => h.skill.id === "gws-gmail-reply-all"), "a meaning-only sibling of a shown skill still shows");
    const api = (await search("claude api sdk tool use messages streaming", 5, { lexicalOnly: true })).map((h) => h.skill.id);
    assert.equal(api.filter((id) => /claude-api/.test(id)).length, 1, `one claude-api cluster: ${api.join(", ")}`);
    assert.deepEqual([...coreIds(["impeccable"])], ["impeccable"], "an exact id wins; impeccable~3 is not what core sync linked");
    const q = "distinctive production grade frontend interfaces design quality";
    const ids = async (prefer) => (await search(q, 3, { lexicalOnly: true, prefer })).map((h) => h.skill.id);
    assert.deepEqual(await ids(coreIds(["impeccable"])), await ids(), "a same-named variant with other text doesn't take the slot as 'preloaded'");
    assert.equal((await ids()).filter((id) => /frontend-design~2|impeccable~3/.test(id)).length, 1, "the copy pair shows once");
});
