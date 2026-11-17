// The semantic layer's model change (MiniLM -> EmbeddingGemma q4): vectors built with another model are never mixed
// with the current one, doctor says which model built them, and cosines are shifted onto the scale the thresholds use.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
const home = fs.mkdtempSync(path.join(os.tmpdir(), "skillrouter-b20-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.SKILLROUTER_HOME = path.join(home, ".skillrouter");
process.env.SKILLROUTER_SERVICE = "0";
fs.mkdirSync(process.env.SKILLROUTER_HOME, { recursive: true });
const { saveVectors, loadVectors, vectorsBuiltWith, cosines, MODEL_TAG, resetVectors, semanticScores } = await import("../src/embed.js");
const { socketPath, runDir } = await import("../src/service-client.js");
const { saveIndex } = await import("../src/index.js");
const { health } = await import("../src/health.js");
const meta = path.join(process.env.SKILLROUTER_HOME, "embeddings.json");
saveIndex({ builtAt: "i1", roots: [], tokenizer: 2, skills: [] });
test("vectors saved now carry the model, quantization and prefix-hash tag and load back", () => {
    saveVectors(["a", "b"], [[1, 0], [0, 1]], "i1");
    assert.equal(JSON.parse(fs.readFileSync(meta, "utf8")).model, MODEL_TAG);
    assert.match(MODEL_TAG, /embeddinggemma-300m.*:q4:[0-9a-f]{8}$/);
    resetVectors();
    assert.equal(loadVectors()?.ids.length, 2);
    assert.equal(vectorsBuiltWith(), undefined);
});
test("vectors built with the old MiniLM model are refused, and doctor names the model to rebuild from", () => {
    saveVectors(["a"], [[1, 0]], "i1");
    const m = JSON.parse(fs.readFileSync(meta, "utf8"));
    fs.writeFileSync(meta, JSON.stringify({ ...m, model: "Xenova/all-MiniLM-L6-v2" }));
    resetVectors();
    assert.equal(loadVectors(), null, "a MiniLM vector must never be compared with a Gemma query");
    assert.equal(vectorsBuiltWith(), "Xenova/all-MiniLM-L6-v2");
    const line = health(home).find((l) => l.startsWith("Vectors:"));
    assert.match(line ?? "", /built with another model \(Xenova\/all-MiniLM-L6-v2\).*index --embeddings/);
});
test("cosines are shifted down 0.02 so the MiniLM-calibrated thresholds keep their meaning", () => {
    saveVectors(["a", "b"], [[1, 0], [0, 1]], "i1");
    resetVectors();
    const v = loadVectors();
    const c = cosines([1, 0], v);
    assert.ok(Math.abs(c.get("a") - 0.98) < 1e-6);
    assert.ok(Math.abs(c.get("b") - -0.02) < 1e-6);
});
// Gemma takes ~1 s to load, over the 800 ms budget, and ~700 MB per process: an MCP server (search_skills) or a hook
// must get the query's vector from the warm service, not load its own model. No model is installed here, so scores
// can only come from the service's answer.
test("a process other than the service gets a query's vector from the service and scores it locally", { skip: process.platform === "win32" }, async () => {
    saveVectors(["a", "b"], [[1, 0], [0, 1]], "i1");
    resetVectors();
    fs.mkdirSync(runDir(), { recursive: true, mode: 0o700 });
    const seen = [];
    const server = net.createServer((c) => {
        let buf = "";
        c.on("data", (d) => {
            buf += d.toString("utf8");
            const nl = buf.indexOf("\n");
            if (nl < 0)
                return;
            const m = /^SR1 (\S+) (\S+) (\d+)$/.exec(buf.slice(0, nl));
            if (!m || buf.length - nl - 1 < Number(m[3]))
                return;
            seen.push(`${m[1]} ${m[2]} ${buf.slice(nl + 1)}`);
            const out = m[2] === "embed" ? JSON.stringify([0, 1]) : "";
            c.end(`OK ${Buffer.byteLength(out)}\n${out}`);
        });
    });
    const sock = socketPath();
    await new Promise((r) => server.listen(sock, r));
    const before = process.env.SKILLROUTER_SERVICE;
    process.env.SKILLROUTER_SERVICE = "1";
    try {
        const r = await semanticScores("find the b skill", 2000, "i1");
        assert.equal(r.status, "on");
        assert.deepEqual(seen, ["- embed find the b skill"], "the raw query goes to the service; it adds the prefix");
        assert.ok(Math.abs(r.scores.get("b") - 0.98) < 1e-6, "scored against the stored vectors, with the shift");
        assert.ok(Math.abs(r.scores.get("a") - -0.02) < 1e-6);
    }
    finally {
        if (before === undefined)
            delete process.env.SKILLROUTER_SERVICE;
        else
            process.env.SKILLROUTER_SERVICE = before;
        await new Promise((r) => server.close(r));
    }
});
