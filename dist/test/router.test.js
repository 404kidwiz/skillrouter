import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BM25, tokenize } from "../src/bm25.js";
import { parseFrontmatter } from "../src/index.js";
import { formatHint } from "../src/hint.js";
test("tokenize drops stop words and splits on punctuation", () => {
    // plurals fold: tests -> test
    assert.deepEqual(tokenize("Fix the failing pytest in tests/test_auth.py"), ["fix", "failing", "pytest", "test", "test", "auth", "py"]);
});
test("BM25 ranks the matching skill first and scores relative to the best hit", () => {
    const bm = new BM25([
        { id: "python-testing", tokens: tokenize("python testing pytest fixtures mocking regression tests") },
        { id: "landing-page-cro", tokens: tokenize("landing page conversion rate optimization audit") },
        { id: "docker-patterns", tokens: tokenize("docker images build cache multi-stage") },
    ]);
    const hits = bm.search("fix a failing pytest regression test", 3);
    assert.equal(hits[0].id, "python-testing");
    assert.equal(hits[0].score, 1);
    assert.ok(hits[0].raw > 0);
    assert.equal(bm.search("thanks that looks good", 3).length, 0);
});
test("parseFrontmatter handles quoted and folded descriptions", () => {
    const fm = parseFrontmatter(`---\nname: demo\ndescription: >\n  Use when testing\n  folded lines.\n---\n# body`);
    assert.equal(fm.name, "demo");
    assert.equal(fm.description, "Use when testing folded lines.");
    assert.equal(parseFrontmatter(`---\ndescription: "quoted text"\n---`).description, "quoted text");
});
test("formatHint speaks each agent's dialect and stays silent when empty", () => {
    assert.equal(formatHint("claude", ""), "");
    assert.equal(JSON.parse(formatHint("cursor", "")).continue, true);
    assert.equal(JSON.parse(formatHint("gemini", "x")).hookSpecificOutput.hookEventName, "BeforeAgent");
    assert.equal(JSON.parse(formatHint("codex", "x")).hookSpecificOutput.hookEventName, "UserPromptSubmit");
    assert.equal(JSON.parse(formatHint("cursor", "x")).additional_context, "x");
});
test("index discovers isolated scratch-home skills", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "skillrouter-"));
    process.env.SKILLROUTER_HOME = path.join(home, ".skillrouter");
    const { buildIndex } = await import("../src/index.js");
    const root = path.join(home, "skills");
    for (const n of ["alpha", "beta"]) {
        fs.mkdirSync(path.join(root, n), { recursive: true });
        fs.writeFileSync(path.join(root, n, "SKILL.md"), `---\nname: ${n}\ndescription: ${n} skill for ${n} tasks\n---\nbody`);
    }
    const index = buildIndex([root]);
    const ids = index.skills.filter((s) => s.root === root).map((s) => s.id).sort();
    assert.deepEqual(ids, ["alpha", "beta"]);
});
