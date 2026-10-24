// Decision learning: each decided turn's verdict per suggested skill, accept rates in the report, and
// suppression of skills agents keep declining.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn, spawnSync } from "node:child_process";
const home = fs.mkdtempSync(path.join(os.tmpdir(), "skillrouter-batch10-"));
process.env.HOME = home;
process.env.USERPROFILE = home; // Windows reads this, not HOME, for os.homedir()
process.env.SKILLROUTER_HOME = path.join(home, ".skillrouter");
fs.mkdirSync(process.env.SKILLROUTER_HOME, { recursive: true });
const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const { decisionOf, mentions: mentionsOf, stopEvent, decisionEvent, toolEvent } = await import("../src/events.js");
const { hint, sessionHash } = await import("../src/hint.js");
const { addShown, addTool, addLoaded, addNudge, markTurn, turnStats } = await import("../src/state.js");
const { addVerdict, readVerdicts, suppressed, setKeep, resetVerdicts } = await import("../src/verdicts.js");
const { readLog, report } = await import("../src/report.js");
const { openCodePlugin } = await import("../src/install.js");
const { saveIndex } = await import("../src/index.js");
const { tokenize } = await import("../src/bm25.js");
process.on("exit", () => fs.rmSync(home, { recursive: true, force: true }));
const verdicts = () => readLog(1).filter((r) => r.tool === "verdict");
test("the Skills: line: real agent styles, named against the suggested ids", () => {
    const named = (text, ids) => { const d = decisionOf([text]); return d && !d.none ? ids.filter((id) => mentionsOf(d.text, id)) : d ? "none" : null; };
    const ids = ["python-testing", "docker-patterns"];
    assert.deepEqual(named("Done.\n\nSkills: python-testing (a), docker-patterns (b)", ids), ids, "parentheticals don't hide later ids");
    assert.deepEqual(named("Skills: python-testing.", ids), ["python-testing"], "trailing period");
    assert.deepEqual(named("**Skills:**\n\n- python-testing\n- docker-patterns\n\nThanks", ids), ids, "a bold label over a list");
    assert.deepEqual(named("Skills:\n- docker-patterns", ids), ["docker-patterns"]);
    assert.deepEqual(named("Skills: python-testing and docker-patterns", ids), ids);
    assert.deepEqual(named("Skills: android_ui_verification, Graphic Design", ["android_ui_verification", "Graphic Design"]), ["android_ui_verification", "Graphic Design"]);
    assert.deepEqual(named("Skills: pdf:pdf, impeccable~3", ["pdf", "impeccable"]), ["pdf", "impeccable"]);
    assert.equal(named("**Skills:** none (a one-line fix)", ids), "none");
    assert.equal(named("`Skills: none (trivial)`", ids), "none", "the decision itself in backticks still counts");
    assert.equal(named("Done.", ids), null);
    assert.equal(named("Write the `Skills:` line at the end.", ids), null, "naming the line is not a decision");
    assert.equal(named("Write `Skills: <ids>` or `Skills: none (<why>)` at the end.", ids), null, "explaining the format is not a decision");
    assert.deepEqual(decisionOf(["Skills: none (start)", "Fixed.\nSkills: python-testing"]), { none: false, text: "python-testing" }, "the last line wins: the final reply's");
});
const now = () => new Date().toISOString();
const transcript = (texts) => {
    const f = path.join(home, `t-${Math.random()}.jsonl`);
    const recs = [{ type: "user", timestamp: now(), message: { role: "user", content: "fix the tests" } },
        ...["Bash", "Bash", "Bash"].map((name) => ({ type: "assistant", timestamp: now(), message: { content: [{ type: "tool_use", name, input: {} }] } })),
        ...texts.map((text) => ({ type: "assistant", timestamp: now(), message: { content: [{ type: "text", text }] } }))];
    fs.writeFileSync(f, recs.map((r) => JSON.stringify(r)).join("\n") + "\n");
    return f;
};
test("Claude: a decided turn records one verdict per suggested skill, once", () => {
    const S = sessionHash("V1"), P = sessionHash("vp1");
    markTurn(S, P);
    addShown(S, ["python-testing", "odoo-docker-deployment"], P);
    const stop = () => stopEvent("claude", JSON.stringify({ session_id: "V1", prompt_id: "vp1", transcript_path: transcript(["Fixed.\n\nSkills: python-testing"]), last_assistant_message: "Fixed.\n\nSkills: python-testing" }));
    assert.equal(stop(), "");
    assert.equal(stop(), "", "a second Stop for the same turn adds nothing");
    const mine = verdicts().filter((r) => r.session === S);
    assert.equal(mine.length, 1);
    assert.deepEqual([mine[0].accepted, mine[0].declined], [["python-testing"], ["odoo-docker-deployment"]]);
    const v = readVerdicts().agents.claude;
    assert.deepEqual([v["python-testing"].accepted, v["odoo-docker-deployment"].declined], [1, 1]);
});
test("Codex: the turn answering a nudge is credited to the nudged turn's checks", () => {
    const S = sessionHash("V2"), T = sessionHash("ct1");
    markTurn(S, T);
    addShown(S, ["git-advanced"], T);
    for (let i = 0; i < 3; i++)
        addTool(S, T);
    const roll = (turn_id, text) => {
        const f = path.join(home, `r-${Math.random()}.jsonl`);
        fs.writeFileSync(f, JSON.stringify({ timestamp: now(), type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text }], internal_chat_message_metadata_passthrough: { turn_id } } }) + "\n");
        return f;
    };
    const first = JSON.parse(stopEvent("codex", JSON.stringify({ session_id: "V2", turn_id: "ct1", transcript_path: roll("ct1", "Pushed."), last_assistant_message: "Pushed." })));
    assert.equal(first.decision, "block");
    // Codex continues under a new turn id; the prompt hook skips the nudge text and doesn't mark a new turn.
    assert.equal(stopEvent("codex", JSON.stringify({ session_id: "V2", turn_id: "ct2", stop_hook_active: true, transcript_path: roll("ct2", "Skills: none (a fast-forward)"), last_assistant_message: "Skills: none (a fast-forward)" })), "");
    const mine = verdicts().filter((r) => r.session === S);
    assert.equal(mine.length, 1);
    assert.deepEqual(mine[0].declined, ["git-advanced"]);
    assert.equal(mine[0].prompt, T, "keyed to the nudged turn");
});
test("the nudge coming back as a prompt doesn't start a new turn (Gemini, no turn id)", async () => {
    const S = sessionHash("V3");
    markTurn(S);
    const start = turnStats(S).start;
    await new Promise((r) => setTimeout(r, 5));
    await hint("gemini", JSON.stringify({ session_id: "V3", prompt: "skillrouter: this turn did real work and skill checks were shown (x), but no skill was loaded" }));
    assert.equal(turnStats(S).start, start);
    await hint("gemini", JSON.stringify({ session_id: "V3", prompt: "a real new request about deployment pipelines" }));
    assert.notEqual(turnStats(S).start, start, "a real prompt does");
});
test("suppression: 5+ declines with under 10% accepted, unless kept; 0 turns it off", () => {
    resetVerdicts();
    for (let i = 0; i < 5; i++)
        addVerdict("claude", [], ["junk-skill"]);
    for (let i = 0; i < 5; i++)
        addVerdict("claude", [], ["useful-skill"]);
    addVerdict("claude", ["useful-skill"], []);
    for (let i = 0; i < 4; i++)
        addVerdict("claude", [], ["new-skill"]);
    assert.deepEqual([...suppressed("claude")], ["junk-skill"], "1 of 6 accepted is not under 10%; 4 declines is not enough");
    setKeep(["junk-skill"], true);
    assert.deepEqual([...suppressed("claude")], []);
    setKeep(["junk-skill"], false);
    process.env.SKILLROUTER_SUPPRESS_AFTER = "0";
    assert.deepEqual([...suppressed("claude")], []);
    delete process.env.SKILLROUTER_SUPPRESS_AFTER;
    assert.equal(resetVerdicts(["junk-skill"]), 1);
    assert.deepEqual([...suppressed("claude")], []);
});
test("a held-back skill is not offered by a trigger", async () => {
    const skill = (id, words) => ({ id, name: id, description: `A skill about ${words} with enough description`, path: "/s", root: "/s", tokens: tokenize(`${id.replace(/-/g, " ")} ${words} `.repeat(2)) });
    saveIndex({ builtAt: "b10", roots: [], tokenizer: 2, skills: [skill("python-testing", "python testing pytest tests writing fixing"), skill("pytest-junk", "python testing pytest tests writing fixing junk"),
            ...Array.from({ length: 40 }, (_, i) => skill(`filler-${i}`, `unrelated invoices calendars ${i}`))] });
    resetVerdicts();
    for (let i = 0; i < 6; i++)
        addVerdict("claude", [], ["pytest-junk"]);
    const job = JSON.stringify({ session_id: "V4", prompt_id: "vp4", cwd: "/repo", tool_name: "Edit", tool_input: { file_path: "/repo/tests/test_a.py" }, _claimed: ["tests"] });
    const out = await toolEvent("claude", job, true);
    assert.match(out, /python-testing/);
    assert.doesNotMatch(out, /pytest-junk/);
    resetVerdicts();
});
test("OpenCode: decisionEvent records the verdict for the turn its plugin reports", () => {
    const S = sessionHash("ses-oc"), P = sessionHash("msg-user-1");
    markTurn(S, P);
    addShown(S, ["k8s-manifest-generator"], P);
    assert.equal(decisionEvent("opencode", JSON.stringify({ session_id: "ses-oc", prompt_id: "msg-user-1", text: "Done.\nSkills: k8s-manifest-generator" })), "");
    const mine = verdicts().filter((r) => r.session === S);
    assert.deepEqual(mine.map((r) => r.accepted), [["k8s-manifest-generator"]]);
});
test("OpenCode plugin: a finished turn's text is sent once, the current turn's never", async () => {
    const seen = path.join(home, "oc-seen.jsonl");
    const stub = path.join(home, "oc-stub.cjs");
    fs.writeFileSync(stub, `let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{require('fs').appendFileSync(${JSON.stringify(seen)}, JSON.stringify({argv:process.argv.slice(2),input:JSON.parse(s)})+'\\n');});`);
    const file = path.join(home, "oc-plugin.mjs");
    fs.writeFileSync(file, openCodePlugin(process.execPath, [stub, "opencode"], 2000));
    const { SkillrouterHints } = await import(pathToFileURL(file).href);
    const hooks = await SkillrouterHints({ directory: "/repo" });
    const msg = (role, id, parentID, text, completed = true) => ({ info: { role, id, sessionID: "ses", parentID, time: { created: 1, ...(completed ? { completed: 2 } : {}) } }, parts: [{ type: "text", id: id + "-p", text }] });
    const messages = [msg("user", "u1", undefined, "first request"), msg("assistant", "a1", "u1", "Done.\nSkills: none (small)"),
        msg("user", "u2", undefined, "second request"), msg("assistant", "a2", "u2", "Working…", false)];
    await hooks["experimental.chat.messages.transform"]({}, { messages });
    await hooks["experimental.chat.messages.transform"]({}, { messages });
    await new Promise((r) => setTimeout(r, 400));
    const calls = fs.readFileSync(seen, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].argv, ["opencode", "decision"]);
    assert.deepEqual(calls[0].input, { session_id: "ses", prompt_id: "u1", text: "Done.\nSkills: none (small)" });
});
test("report: accept rates per skill and what is held back", () => {
    resetVerdicts();
    for (let i = 0; i < 5; i++)
        addVerdict("claude", [], ["odoo-docker-deployment"]);
    const t = now();
    const text = report(7, [
        { ts: t, client: "hook/claude", agent: "claude", tool: "verdict", accepted: ["python-testing"], declined: ["odoo-docker-deployment"] },
        { ts: t, client: "hook/codex", agent: "codex", tool: "verdict", accepted: [], declined: ["odoo-docker-deployment"] },
    ]);
    assert.match(text, /Skill decisions: 2 decided turns after checks; 1 of 3 suggested skills accepted \(33%\)\./);
    assert.match(text, /Most declined \(accepted\/suggested\):\n {5}0\/2  odoo-docker-deployment/);
    assert.match(text, /Held back from claude's checks .*odoo-docker-deployment \(0\/5\)/);
});
test("CLI: suppress lists, keeps and resets", () => {
    const run = (...args) => spawnSync(process.execPath, [cli, "suppress", ...args], { env: process.env, encoding: "utf8" }).stdout;
    assert.match(run(), /Held back after declines in 5\+ sessions[\s\S]*claude: odoo-docker-deployment: accepted 0 of 5/);
    assert.match(run("keep", "odoo-docker-deployment"), /kept \(never held back\): odoo-docker-deployment/);
    assert.match(run(), /none[\s\S]*Kept \(never held back\): odoo-docker-deployment/);
    assert.match(run("reset"), /forgot decision counts for 1 skill/);
});
test("a sibling named only as similar is not counted as declined", () => {
    const S = sessionHash("V5"), P = sessionHash("vp5");
    markTurn(S, P);
    addShown(S, ["python-testing"], P, { "python-testing": ["python-testing-patterns"] });
    stopEvent("claude", JSON.stringify({ session_id: "V5", prompt_id: "vp5", transcript_path: transcript(["Skills: python-testing"]), last_assistant_message: "Skills: python-testing" }));
    const mine = verdicts().filter((r) => r.session === S);
    assert.deepEqual([mine[0].accepted, mine[0].declined], [["python-testing"], []]);
});
test("Claude never borrows a stale nudge: its continuation keeps the same prompt_id", () => {
    const S = sessionHash("V6");
    addNudge(S, ["old-skill"], sessionHash("old-prompt"), Date.now() - 60_000);
    markTurn(S, sessionHash("vp6"));
    addShown(S, ["python-testing"], sessionHash("vp6"));
    stopEvent("claude", JSON.stringify({ session_id: "V6", prompt_id: "vp6", stop_hook_active: true, transcript_path: transcript(["Skills: none (typo fix)"]), last_assistant_message: "Skills: none (typo fix)" }));
    const mine = verdicts().filter((r) => r.session === S);
    assert.deepEqual(mine.map((r) => r.declined), [["python-testing"]], "only this turn's check, not the old nudge's");
});
test("Codex continuation: the nudged turn's checks and a new trigger's are both judged, and the nudge is used once", () => {
    const S = sessionHash("V7"), T1 = sessionHash("c71"), T2 = sessionHash("c72");
    addNudge(S, ["git-advanced"], T1, Date.now() - 1000, T1);
    addShown(S, ["git-workflow"], T2); // a trigger fired while answering the nudge
    markTurn(S, T2);
    const roll = path.join(home, "r7.jsonl");
    fs.writeFileSync(roll, JSON.stringify({ timestamp: now(), type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Skills: git-workflow" }], internal_chat_message_metadata_passthrough: { turn_id: "c72" } } }) + "\n");
    const stop = () => stopEvent("codex", JSON.stringify({ session_id: "V7", turn_id: "c72", stop_hook_active: true, transcript_path: roll, last_assistant_message: "Skills: git-workflow" }));
    stop();
    const mine = verdicts().filter((r) => r.session === S);
    assert.deepEqual([mine[0].accepted, mine[0].declined, mine[0].prompt], [["git-workflow"], ["git-advanced"], T1]);
    stop();
    assert.equal(verdicts().filter((r) => r.session === S).length, 1);
});
test("taking a sibling the check named counts as taking the suggestion", () => {
    const S = sessionHash("V8"), P = sessionHash("vp8");
    markTurn(S, P);
    addShown(S, ["python-testing"], P, { "python-testing": ["python-testing-patterns"] });
    stopEvent("claude", JSON.stringify({ session_id: "V8", prompt_id: "vp8", transcript_path: transcript(["Skills: python-testing-patterns"]), last_assistant_message: "Skills: python-testing-patterns" }));
    assert.deepEqual(verdicts().filter((r) => r.session === S)[0].accepted, ["python-testing"]);
});
test("one session's repeated declines count once", () => {
    resetVerdicts();
    for (let i = 0; i < 6; i++) {
        const P = sessionHash(`vp9-${i}`);
        markTurn(sessionHash("V9"), P);
        addShown(sessionHash("V9"), ["noisy-skill"], P);
        stopEvent("claude", JSON.stringify({ session_id: "V9", prompt_id: `vp9-${i}`, transcript_path: transcript(["Skills: none (no)"]), last_assistant_message: "Skills: none (no)" }));
    }
    assert.equal(readVerdicts().agents.claude["noisy-skill"].declined, 1);
    assert.deepEqual([...suppressed("claude")], []);
});
test("verdicts.json: concurrent writers lose nothing; bad files are set aside; bad entries are skipped", () => {
    resetVerdicts();
    const lib = pathToFileURL(fileURLToPath(new URL("../src/verdicts.js", import.meta.url))).href;
    const procs = Array.from({ length: 8 }, () => spawnSync(process.execPath, ["--input-type=module", "-e",
        `const m = await import(${JSON.stringify(lib)}); for (let i = 0; i < 15; i++) m.addVerdict("claude", [], ["race-skill"]);`], { env: process.env }));
    assert.ok(procs.every((p) => p.status === 0));
    // spawnSync runs them one after another; run them truly in parallel too:
    return Promise.all(Array.from({ length: 8 }, () => new Promise((r) => spawn(process.execPath, ["--input-type=module", "-e",
        `const m = await import(${JSON.stringify(lib)}); for (let i = 0; i < 15; i++) m.addVerdict("claude", ["race-skill"], []);`], { env: process.env }).on("exit", r)))).then(() => {
        const e = readVerdicts().agents.claude["race-skill"];
        assert.deepEqual([e.declined, e.accepted], [120, 120]);
        const file = path.join(process.env.SKILLROUTER_HOME, "verdicts.json");
        fs.writeFileSync(file, '{"agents": {"claude": {"x": null, "ok": {"shown": 1, "accepted": 0, "declined": 1, "last": "' + now() + '"}}}, "keep": ["k"]}');
        assert.deepEqual(Object.keys(readVerdicts().agents.claude), ["ok"]);
        assert.doesNotThrow(() => suppressed("claude"));
        fs.writeFileSync(file, "{ torn");
        assert.deepEqual([...suppressed("claude")], [], "unreadable reads as nothing held back");
        addVerdict("claude", [], ["fresh"]);
        assert.ok(fs.readdirSync(process.env.SKILLROUTER_HOME).some((f) => f.startsWith("verdicts.json.bad-")), "the bad file is kept aside");
        assert.equal(readVerdicts().agents.claude.fresh.declined, 1);
    });
});
test("suppression expires 30 days after a skill's last verdict; an empty threshold means the default", () => {
    resetVerdicts();
    for (let i = 0; i < 5; i++)
        addVerdict("claude", [], ["old-skill"]);
    assert.deepEqual([...suppressed("claude")], ["old-skill"]);
    const file = path.join(process.env.SKILLROUTER_HOME, "verdicts.json");
    const v = JSON.parse(fs.readFileSync(file, "utf8"));
    v.agents.claude["old-skill"].last = new Date(Date.now() - 31 * 86400e3).toISOString();
    fs.writeFileSync(file, JSON.stringify(v));
    assert.deepEqual([...suppressed("claude")], [], "offered again after 30 days");
    process.env.SKILLROUTER_SUPPRESS_AFTER = "";
    v.agents.claude["old-skill"].last = now();
    fs.writeFileSync(file, JSON.stringify(v));
    assert.deepEqual([...suppressed("claude")], ["old-skill"]);
    delete process.env.SKILLROUTER_SUPPRESS_AFTER;
});
test("OpenCode: a prompt queued mid-turn doesn't end the turn; a late report isn't credited with later loads", async () => {
    const seen = path.join(home, "oc2-seen.jsonl");
    const stub = path.join(home, "oc2-stub.cjs");
    fs.writeFileSync(stub, `let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{require('fs').appendFileSync(${JSON.stringify(seen)}, s+'\\n');});`);
    const file = path.join(home, "oc2-plugin.mjs");
    fs.writeFileSync(file, openCodePlugin(process.execPath, [stub, "opencode"], 2000));
    const { SkillrouterHints } = await import(pathToFileURL(file).href);
    const hooks = await SkillrouterHints({});
    const msg = (role, id, parentID, text, completed = true) => ({ info: { role, id, sessionID: "s2", parentID, time: { created: 1, ...(completed ? { completed: 2 } : {}) } }, parts: [{ type: "text", id: id + "-p", text }] });
    const queued = [msg("user", "u1", undefined, "a"), msg("assistant", "a1", "u1", "step one"), msg("user", "u2", undefined, "queued"), msg("assistant", "a1b", "u1", "still working", false)];
    await hooks["experimental.chat.messages.transform"]({}, { messages: queued });
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(!fs.existsSync(seen), "the first turn is still running");
    await hooks["experimental.chat.messages.transform"]({}, { messages: [...queued.slice(0, 3), msg("assistant", "a1b", "u1", "Done. Skills: none (x)"), msg("assistant", "a2", "u2", "on it", false)] });
    await new Promise((r) => setTimeout(r, 400));
    assert.deepEqual(JSON.parse(fs.readFileSync(seen, "utf8").trim()), { session_id: "s2", prompt_id: "u1", text: "step one\nDone. Skills: none (x)" });
    // decisionEvent only counts loads inside the turn's own span.
    const S = sessionHash("s3"), U1 = sessionHash("x1"), U2 = sessionHash("x2");
    markTurn(S, U1);
    addShown(S, ["helm-chart-scaffolding"], U1);
    await new Promise((r) => setTimeout(r, 5));
    markTurn(S, U2);
    addLoaded(S, "helm-chart-scaffolding");
    decisionEvent("opencode", JSON.stringify({ session_id: "s3", prompt_id: "x1", text: "no line" }));
    assert.equal(verdicts().filter((r) => r.session === S).length, 0, "a load in the next turn doesn't decide this one");
});
test("second QA pass: namespaced ids, early lines, lapsed holds, per-host holds, rescue, parse time, odd ids", async () => {
    const d = decisionOf(["Skills: anthropic-skills:pdf, anthropic-skills:docx (both used)"]);
    assert.ok(mentionsOf(d.text, "pdf") && mentionsOf(d.text, "docx"), d.text);
    // An early line can't answer checks shown later: without a final line only loads count, as accepts.
    const S = sessionHash("W1"), P = sessionHash("wp1");
    markTurn(S, P);
    addShown(S, ["python-testing", "docker-patterns"], P);
    stopEvent("claude", JSON.stringify({ session_id: "W1", prompt_id: "wp1", transcript_path: transcript(["Skills: none (starting)", "Done."]), last_assistant_message: "Done." }));
    assert.equal(verdicts().filter((r) => r.session === S).length, 0, "no final line, no loads: nothing recorded");
    // A lapsed hold starts again from zero.
    resetVerdicts();
    const file = path.join(process.env.SKILLROUTER_HOME, "verdicts.json");
    fs.writeFileSync(file, JSON.stringify({ agents: { claude: { "old-noise": { shown: 42, accepted: 2, declined: 40, last: new Date(Date.now() - 31 * 86400e3).toISOString() } } }, keep: [] }));
    addVerdict("claude", [], ["old-noise"]);
    assert.deepEqual(readVerdicts().agents.claude["old-noise"].declined, 1);
    assert.deepEqual([...suppressed("claude")], []);
    // Holds are per host.
    resetVerdicts();
    for (let i = 0; i < 5; i++)
        addVerdict("gemini", [], ["gemini-noise"]);
    assert.deepEqual([[...suppressed("gemini")], [...suppressed("claude")]], [["gemini-noise"], []]);
    // A held skill the agent loads on its own earns an accept back.
    await toolEvent("gemini", JSON.stringify({ session_id: "W2", tool_name: "mcp_skillrouter_read_skill", tool_input: { id: "gemini-noise" } }), false);
    assert.equal(readVerdicts().agents.gemini["gemini-noise"].accepted, 1);
    assert.deepEqual([...suppressed("gemini")], []);
    // Parsing stays linear.
    const t0 = Date.now();
    decisionOf([("Skills: none (x)\n").repeat(20000)]);
    assert.ok(Date.now() - t0 < 500, `took ${Date.now() - t0} ms`);
    // Odd skill names are plain keys.
    addVerdict("claude", [], ["constructor", "__proto__"]);
    assert.equal({}.shown, undefined);
    assert.equal(readVerdicts().agents.claude["constructor"].declined, 1);
    // A file holding valid JSON that isn't a verdicts object is set aside, not overwritten.
    fs.writeFileSync(file, "null");
    addVerdict("claude", [], ["x"]);
    assert.ok(fs.readdirSync(process.env.SKILLROUTER_HOME).filter((f) => f.startsWith("verdicts.json.bad-")).length >= 2);
    resetVerdicts();
});
