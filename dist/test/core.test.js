import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
// Own process (node --test runs each file separately), so HOME can be redirected before paths.js loads.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "skillrouter-core-"));
process.env.HOME = home;
process.env.SKILLROUTER_HOME = path.join(home, ".skillrouter");
const { readCoreEntries, writeCore, skipCore, syncCore } = await import("../src/core.js");
const { buildIndex, saveIndex } = await import("../src/index.js");
const { isSynthetic, report } = await import("../src/report.js");
test("core skip markers survive add/remove and keep a skill out of only the skipping agent's folder", () => {
    const lib = path.join(home, "lib");
    for (const n of ["pdf", "impeccable"]) {
        fs.mkdirSync(path.join(lib, n), { recursive: true });
        fs.writeFileSync(path.join(lib, n, "SKILL.md"), `---\nname: ${n}\ndescription: ${n}\n---\n`);
    }
    saveIndex(buildIndex([lib]));
    writeCore(["pdf", "impeccable"]);
    assert.equal(skipCore("pdf", ["claude"]), true);
    assert.equal(skipCore("nope", ["claude"]), false);
    writeCore(["pdf", "impeccable", "impeccable"]); // rewrite must keep the marker and dedupe
    assert.deepEqual(readCoreEntries().map((e) => [e.id, [...e.skip]]), [["pdf", ["claude"]], ["impeccable", []]]);
    const r = syncCore(["claude", "codex", "cursor"]);
    assert.equal(r.missing.length, 0);
    assert.equal(r.skipped, 1);
    const claude = fs.readdirSync(path.join(home, ".claude", "skills")).sort();
    const shared = fs.readdirSync(path.join(home, ".agents", "skills")).sort();
    assert.deepEqual(claude, ["impeccable"]);
    assert.deepEqual(shared, ["impeccable", "pdf"]);
    // Removing a skill from core removes its link from the agent folders on the next sync (real folders are never touched).
    writeCore(["pdf"]);
    const after = syncCore(["claude", "codex", "cursor"]);
    assert.equal(after.unlinked, 2);
    assert.deepEqual(fs.readdirSync(path.join(home, ".claude", "skills")), []);
    assert.deepEqual(fs.readdirSync(path.join(home, ".agents", "skills")), ["pdf"]);
    writeCore(["pdf", "impeccable"]);
    syncCore(["claude", "codex", "cursor"]);
    // A shared folder drops a skill only when every agent reading it skips it.
    skipCore("pdf", ["codex", "cursor"]);
    fs.unlinkSync(path.join(home, ".agents", "skills", "pdf"));
    assert.equal(syncCore(["codex", "cursor"]).skipped, 1);
    assert.deepEqual(fs.readdirSync(path.join(home, ".agents", "skills")), ["impeccable"]);
});
test("report separates synthetic probe traffic from organic use", () => {
    const ts = new Date().toISOString();
    const later = new Date(Date.now() + 1000).toISOString();
    const probe = { ts, client: "skillrouter-integration-probe/codex/1", tool: "read_skill", found: true, skill: "demo", agent: "codex", hint_id: "h1" };
    assert.equal(isSynthetic(probe), true);
    assert.equal(isSynthetic({ ...probe, client: "codex-mcp-client/0.163.0" }), false);
    assert.equal(isSynthetic({ ...probe, client: "hook/codex" }), false);
    const hint = { ts, client: "hook/codex", tool: "hint", agent: "codex", hint_id: "h1", hits: [["demo", 1]] };
    const text = report(7, [hint, { ...probe, ts: later }, { ...probe, ts: later, client: "codex-mcp-client/0.163.0", tool: "search_skills" }]);
    assert.match(text, /1 searches, 0 successful MCP skill loads/);
    assert.match(text, /Excluded as synthetic .*1 loads from skillrouter-integration-probe\/codex\/1/);
    assert.match(text, /0\/1 shown hints have a correlated organic successful load .*\(1 more were followed only by synthetic probe loads\)/);
});
