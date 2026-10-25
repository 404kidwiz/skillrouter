// Description expansion: a local model writes requests and keywords per skill; they are appended to the skill's text before embedding.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "skillrouter-b17-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.SKILLROUTER_HOME = path.join(home, ".skillrouter");
process.env.SKILLROUTER_SERVICE = "0";
fs.mkdirSync(process.env.SKILLROUTER_HOME, { recursive: true });
process.on("exit", () => fs.rmSync(home, { recursive: true, force: true }));
const { readExpansions, expansionKey, openingOf, expansionText, expandLibrary, expansionCoverage, EXPANSION_FILE, EXPANSION_VERSION } = await import("../src/expand.js");
const { buildIndexFrom, saveIndex } = await import("../src/index.js");
const { skillText } = await import("../src/embed.js");

const roots = path.join(home, "skills");
const skill = (dir: string, name: string, description: string, body = "Steps for the skill go here.") => {
  fs.mkdirSync(path.join(roots, dir), { recursive: true });
  fs.writeFileSync(path.join(roots, dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`);
};
skill("pdf-tools", "pdf-tools", "Read, merge and split PDF files.");
skill("toolbox-pdf-tools", "toolbox-pdf-tools", "Read, merge and split PDF files."); // a copy under another name
skill("docker-help", "docker-help", "Dockerfile and compose patterns.");

/** A stand-in for an Ollama server: records the requests, answers with canned JSON, and can fail on demand. */
async function fakeOllama(handler: (body: any, n: number) => { status?: number; message?: unknown } = () => ({})) {
  const bodies: any[] = [];
  const server = http.createServer((req, res) => {
    let raw = ""; req.on("data", (d) => (raw += d));
    req.on("end", () => {
      const body = JSON.parse(raw); bodies.push({ url: req.url, ...body });
      const r = handler(body, bodies.length);
      res.writeHead(r.status ?? 200, { "Content-Type": "application/json" });
      const name = /Skill name: (.*)/.exec(body.messages[0].content)?.[1] ?? "x";
      res.end(JSON.stringify({ message: { content: JSON.stringify(r.message ?? { does: `does ${name}`, queries: [`how do I use ${name}`, `help with ${name} please`], keywords: [`${name}`.toUpperCase(), "tooling"] }) } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, bodies, close: () => new Promise<void>((r) => { server.closeAllConnections?.(); server.close(() => r()); }) };
}

test("readExpansions keeps usable rows, lowercases keywords, caps lengths, lets the last row win, and skips junk", () => {
  const f = path.join(home, "rows.jsonl");
  fs.writeFileSync(f, [
    JSON.stringify({ key: "a", queries: ["How do I merge PDFs?"], keywords: ["PDF", "Merge"] }),
    JSON.stringify({ key: "b", queries: [], keywords: [] }),
    JSON.stringify({ key: "c", error: "HTTP 500", queries: ["x"], keywords: ["y"] }),
    "not json", "", JSON.stringify({ queries: ["no key"] }),
    JSON.stringify({ key: "a", queries: ["q1", "q2", "q3", "q4"], keywords: ["k1", "k2", "k3", "k4", "k5", "k6", "k7"] }),
    JSON.stringify({ key: "d", queries: ["x".repeat(500)], keywords: [] }),
  ].join("\n"));
  const m = readExpansions(f);
  assert.deepEqual([...m.keys()].sort(), ["a", "d"]);
  assert.deepEqual(m.get("a"), { queries: ["q1", "q2", "q3"], keywords: ["k1", "k2", "k3", "k4", "k5", "k6"] });
  assert.equal(m.get("d")!.queries[0].length, 90);
  assert.equal(readExpansions(path.join(home, "missing.jsonl")).size, 0);
  assert.equal(expansionText({ queries: ["a b", "c d"], keywords: ["x", "y"] }), "Asked as: a b; c d. x, y.");
  assert.equal(expansionText({ queries: [], keywords: ["x"] }), "x.");
});

test("a key follows the description and the opening, not the name or whitespace", () => {
  const k = expansionKey("Read PDFs.", "Steps");
  assert.equal(k, expansionKey("  Read PDFs.\n", "Steps"));
  assert.notEqual(k, expansionKey("Read and merge PDFs.", "Steps"));
  assert.notEqual(k, expansionKey("Read PDFs.", "Other steps"));
  assert.match(k, /^[0-9a-f]{16}$/);
  assert.equal(EXPANSION_VERSION, 2);
  assert.equal(openingOf("---\nname: x\n---\n\nHello   there\n\nworld"), "Hello there world");
  assert.equal(openingOf("no frontmatter at all").length, 21);
  assert.equal(openingOf("x ".repeat(400)).length, 250);
});

test("expandLibrary asks once per distinct description, resumes, retries failures, and sends the shape that was measured", async () => {
  const index = buildIndexFrom([roots], new Map());
  const file = path.join(home, "run1.jsonl");
  const srv = await fakeOllama();
  try {
    const s = await expandLibrary(index, { url: srv.url + "/", model: "m1", concurrency: 2, file });
    assert.deepEqual(s, { distinct: 2, already: 0, written: 2, errors: 0 }, "the copy shares its original's rewrite");
    assert.equal(srv.bodies.length, 2);
    const b = srv.bodies[0];
    assert.equal(b.url, "/api/chat"); assert.equal(b.model, "m1"); assert.equal(b.stream, false); assert.equal(b.think, false);
    assert.equal(b.options.temperature, 0); assert.deepEqual(b.format.required, ["does", "queries", "keywords"]);
    assert.match(b.messages[0].content, /Description: (Read, merge and split PDF files\.|Dockerfile and compose patterns\.)/);
    const rows = readExpansions(file);
    assert.equal(rows.size, 2);
    assert.ok(rows.get(expansionKey("Dockerfile and compose patterns.", openingOf(fs.readFileSync(path.join(roots, "docker-help", "SKILL.md"), "utf8"))))!.keywords.includes("docker-help"));
    const again = await expandLibrary(index, { url: srv.url, file });
    assert.deepEqual(again, { distinct: 2, already: 2, written: 0, errors: 0 });
    assert.equal(srv.bodies.length, 2, "a finished library asks nothing");
  } finally { await srv.close(); }

  const file2 = path.join(home, "run2.jsonl");
  const flaky = await fakeOllama((_b, n) => (n <= 3 ? { status: 500 } : {}));
  try {
    const first = await expandLibrary(index, { url: flaky.url, file: file2, concurrency: 1, limit: 1 });
    assert.deepEqual([first.written, first.errors], [0, 1], "three failures in a row give up on that description");
    assert.equal(flaky.bodies.length, 3, "three tries, no more");
    const second = await expandLibrary(index, { url: flaky.url, file: file2, concurrency: 1, limit: 1 });
    assert.deepEqual([second.written, second.errors, second.already], [1, 0, 0], "the next run tries again and succeeds; limit stops at one");
  } finally { await flaky.close(); }
  const down = await fakeOllama(() => ({ status: 500 }));
  try {
    const f3 = path.join(home, "run3.jsonl");
    const s = await expandLibrary(index, { url: down.url, file: f3 });
    assert.deepEqual([s.written, s.errors], [0, 2], "a request that fails three times writes nothing, so a rerun tries it again");
    assert.equal(fs.existsSync(f3), false);
    const unusable = await fakeOllama(() => ({ message: { does: "x", queries: [], keywords: [] } }));
    try { assert.equal((await expandLibrary(index, { url: unusable.url, file: f3 })).errors, 2, "an empty answer is a failure, not a row"); } finally { await unusable.close(); }
  } finally { await down.close(); }
});

test("the index attaches an expansion by key, ignores a stale one, and is unchanged without any", () => {
  const plain = buildIndexFrom([roots], new Map());
  assert.ok(plain.skills.every((s) => !("expansion" in s)), "no expansions: the same entries as before");
  const open = (d: string) => openingOf(fs.readFileSync(path.join(roots, d, "SKILL.md"), "utf8"));
  const rows = new Map([
    [expansionKey("Read, merge and split PDF files.", open("pdf-tools")), { queries: ["merge two pdfs"], keywords: ["pdf"] }],
    [expansionKey("An older description of docker.", open("docker-help")), { queries: ["stale"], keywords: ["stale"] }],
  ]);
  const idx = buildIndexFrom([roots], rows);
  const by = Object.fromEntries(idx.skills.map((s) => [s.name, s]));
  assert.equal(by["pdf-tools"].expansion, "Asked as: merge two pdfs. pdf.");
  assert.equal(by["toolbox-pdf-tools"].expansion, "Asked as: merge two pdfs. pdf.", "a copy shares it");
  assert.equal(by["docker-help"].expansion, undefined, "a row for an older description does not match");
  assert.deepEqual(by["pdf-tools"].tokens, plain.skills.find((s) => s.name === "pdf-tools")!.tokens, "BM25 never sees an expansion: it ranked worse when it did");
  saveIndex(idx);
  assert.deepEqual(expansionCoverage(idx, path.join(home, "none.jsonl")), { skills: 3, covered: 0, rows: 0, stale: 0 });
  const f = path.join(home, "cov.jsonl");
  fs.writeFileSync(f, [...rows.entries()].map(([key, e]) => JSON.stringify({ key, ...e })).join("\n"));
  assert.deepEqual(expansionCoverage(idx, f), { skills: 3, covered: 2, rows: 2, stale: 1 });
});

test("skillText: the old text without an expansion, a 300-character description plus the expansion with one, never past 512", () => {
  const s = { name: "pdf-tools", description: "Read PDFs." };
  assert.equal(skillText(s), "pdf tools: Read PDFs.");
  assert.equal(skillText({ ...s, expansion: "Asked as: merge pdfs. pdf." }), "pdf tools: Read PDFs. Asked as: merge pdfs. pdf.");
  const long = { name: "n", description: "d".repeat(900), expansion: "E".repeat(400) };
  const t = skillText(long);
  assert.equal(t.length, 512);
  assert.equal(t.slice(0, 3 + 300), "n: " + "d".repeat(300));
  assert.ok(t.includes("EEEE"), "the expansion keeps its room");
  assert.equal(skillText({ name: "n", description: "d".repeat(900) }).length, 512, "unchanged for a skill without one");
});

const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const run = (args: string[], env: Record<string, string> = {}) => new Promise<{ code: number; out: string; err: string }>((resolve) =>
  execFile(process.execPath, [cli, ...args], { env: { ...process.env, ...env }, encoding: "utf8" }, (e, out, err) => resolve({ code: (e as any)?.code ?? 0, out, err })));

test("the expand command needs an index, reports status, writes rows through the URL from the flag or the environment, and says what to run next", async () => {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), "sr-b17-cli-"));
  const env = { SKILLROUTER_HOME: path.join(h, ".skillrouter"), HOME: h, USERPROFILE: h, SKILLROUTER_SERVICE: "0" };
  fs.mkdirSync(env.SKILLROUTER_HOME, { recursive: true });
  const none = await run(["expand", "status"], env);
  assert.notEqual(none.code, 0); assert.match(none.err, /run `skillrouter index` first/);
  const index = buildIndexFrom([roots], new Map());
  fs.writeFileSync(path.join(env.SKILLROUTER_HOME, "index.json"), JSON.stringify(index));
  assert.match((await run(["expand", "status"], env)).out, /0 of 3 skills have an expansion \(0 stored, 0 no longer matching/);
  const srv = await fakeOllama();
  try {
    const r = await run(["expand", "--url", srv.url, "--model", "tiny", "--concurrency", "2"], env);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /2 distinct descriptions: 0 already expanded, 2 written, 0 failed/);
    assert.match(r.out, /Next: skillrouter index --embeddings/);
    assert.equal(srv.bodies[0].model, "tiny");
    assert.match((await run(["expand", "status"], env)).out, /3 of 3 skills have an expansion \(2 stored/);
    const second = await run(["expand"], { ...env, SKILLROUTER_EXPAND_URL: srv.url });
    assert.match(second.out, /2 already expanded, 0 written/); assert.match(second.out, /Nothing new to embed/);
    assert.equal(srv.bodies.length, 2, "the second run asked nothing");
  } finally { await srv.close(); }
  assert.ok(fs.existsSync(path.join(env.SKILLROUTER_HOME, "expansions.jsonl")));
  assert.ok(EXPANSION_FILE.endsWith("expansions.jsonl"));
  // `index` then picks the rows up, so the next embedding run sees them.
  const rebuilt = await run(["index", "--root", roots], env);
  assert.equal(rebuilt.code, 0, rebuilt.err);
  assert.equal(JSON.parse(fs.readFileSync(path.join(env.SKILLROUTER_HOME, "index.json"), "utf8")).skills.filter((s: any) => s.expansion).length, 3);
});
