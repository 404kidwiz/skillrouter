import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { SR_DIR } from "./paths.js";
import { query as askService, serviceEnabled } from "./service-client.js";
import { renameSyncRetry } from "./platform.js";
// Optional semantic layer: EmbeddingGemma vectors for every skill's name + description, stored as one
// Float32 file beside the index so a hook process reads it in milliseconds. Needs the optional
// peer dependency @huggingface/transformers; everything degrades to lexical when it is missing.
//
// Why this model (measured 2026-11-17 on 240 real search queries with blind labels, held-out half in brackets):
// all-MiniLM-L6-v2 had 82% precision, 19% confident answers on queries no skill fits, 72% recall [79/24/68];
// embeddinggemma-300m q4 has 93/5/80 [91/6/75], 9 ms per query and ~580 MB resident in the warm service.
// Its q8 build scored the same at 1.75 GB; Qwen3-Embedding-0.6B scored below MiniLM. Gemma wants task prefixes.
export const MODEL = "onnx-community/embeddinggemma-300m-ONNX";
const DTYPE = "q4";
const QUERY_PREFIX = "task: search result | query: ";
const DOC_PREFIX = "title: none | text: ";
/** Written into the vector file: another model, quantization or prefix makes stored vectors unusable. */
export const MODEL_TAG = `${MODEL}:${DTYPE}:${createHash("sha256").update(QUERY_PREFIX + "\n" + DOC_PREFIX).digest("hex").slice(0, 8)}`;
// Gemma's query-to-skill cosines run ~0.02 above MiniLM's for matches of the same strength (same set). Shifting
// them keeps one scale for the query thresholds in hint.ts and routing.ts, which were calibrated on MiniLM. (The
// skill-to-skill duplicate cut in search.ts compares raw vectors and is not shifted.)
const COS_SHIFT = -0.02;
export const MODELS_DIR = path.join(SR_DIR, "models");
const VEC_FILE = path.join(SR_DIR, "embeddings.f32");
const META_FILE = path.join(SR_DIR, "embeddings.json");
/** The files the vectors live in, for anything that watches them for changes. */
export const VECTOR_FILES = [META_FILE, VEC_FILE];
let pipe = null; // the promise, so concurrent first calls load the model once
/**
 * The warm service holds the model; every other process (an MCP server answering search_skills, a hook that runs
 * without the service) asks it for a query's vector instead of loading its own copy: Gemma takes ~1 s to load, more
 * than the 800 ms budget, and ~700 MB per process. Only the service itself, or a process with the service off, embeds
 * locally, and others fall back to it when the service cannot answer.
 */
let local = false;
export function embedLocally() { local = true; }
/** Why the last embedding attempt failed, for doctor and the usage log; cleared by a success. */
export let lastEmbedError;
/**
 * The ES entry of an installed package, by its real path. Node can reach a package through a link (pnpm's layout, a
 * linked checkout) and, in some processes on Node 26, import it under the link path, where it cannot see its own
 * dependencies beside it in the store ("Cannot find package 'onnxruntime-common'"). The real path always can.
 */
export function packageEntry(name, from = import.meta.url) {
    const req = createRequire(from);
    let dir = path.dirname(fs.realpathSync(req.resolve(name)));
    const manifest = () => { try {
        return JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
    }
    catch {
        return null;
    } };
    let pkg = manifest();
    while (pkg?.name !== name) {
        const up = path.dirname(dir);
        if (up === dir)
            throw new Error(`${name}: package root not found`);
        dir = up;
        pkg = manifest();
    }
    const pick = (x) => typeof x === "string" ? x : x && typeof x === "object" ? (pick(x.node) ?? pick(x.import) ?? pick(x.default)) : undefined;
    const entry = pick(pkg.exports?.["."] ?? pkg.exports) ?? pkg.module ?? pkg.main ?? "index.js";
    return pathToFileURL(path.join(dir, entry)).href;
}
/**
 * Embed texts with the local model. `allowRemote` permits the one-time download (index time only, never in a hook).
 * `kind` picks the model's task prefix: a search query, or a skill's text.
 */
export async function embed(texts, allowRemote = false, kind = "query") {
    pipe ??= (async () => {
        const mod = await import(packageEntry("@huggingface/transformers")).catch((e) => {
            throw new Error(`Embeddings need @huggingface/transformers installed next to skillrouter (npm i @huggingface/transformers): ${String(e?.message ?? e).split("\n")[0].slice(0, 160)}`);
        });
        mod.env.cacheDir = MODELS_DIR;
        mod.env.allowRemoteModels = allowRemote;
        // EmbeddingGemma's ONNX graph ends in its own pooling and projection (sentence_embedding); the feature-extraction
        // pipeline would mean-pool the raw token states instead and skip the projection.
        const tokenizer = await mod.AutoTokenizer.from_pretrained(MODEL);
        const model = await mod.AutoModel.from_pretrained(MODEL, { dtype: DTYPE });
        return (async (t) => {
            const out = await model(await tokenizer(t, { padding: true, truncation: true }));
            return out.sentence_embedding.normalize(2, -1);
        });
    })();
    const p = pipe;
    const prefix = kind === "query" ? QUERY_PREFIX : DOC_PREFIX;
    try {
        const out = await (await p)(texts.map((t) => prefix + t), {});
        lastEmbedError = undefined;
        return out.tolist();
    }
    catch (e) {
        if (pipe === p)
            pipe = null;
        lastEmbedError = String(e?.message ?? e).split("\n")[0].slice(0, 200);
        throw e;
    }
}
export function skillText(s) {
    return `${s.name.replace(/[-_~]/g, " ")}: ${s.description}`.slice(0, 512);
}
export function textHash(text) {
    return createHash("sha256").update(text).digest("hex").slice(0, 16);
}
/** Vectors are stamped with the index they were built for; any other index makes them stale. */
export function saveVectors(ids, rows, indexBuiltAt, hashes) {
    const dim = rows[0]?.length ?? 0;
    const data = new Float32Array(ids.length * dim);
    rows.forEach((r, i) => data.set(r, i * dim));
    fs.mkdirSync(SR_DIR, { recursive: true });
    fs.writeFileSync(VEC_FILE + ".tmp", Buffer.from(data.buffer));
    fs.writeFileSync(META_FILE + ".tmp", JSON.stringify({ model: MODEL_TAG, dim, count: ids.length, builtAt: new Date().toISOString(), indexBuiltAt, ids, ...(hashes ? { hashes } : {}) }));
    renameSyncRetry(VEC_FILE + ".tmp", VEC_FILE);
    renameSyncRetry(META_FILE + ".tmp", META_FILE);
}
/** Embed only skills whose text changed since the previous vector build; reuse unchanged Float32 rows. */
export async function embedSkills(skills, previousSkills, allowRemote = true) {
    const prevVec = loadVectors();
    const reusable = new Map();
    if (prevVec && prevVec.dim > 0) {
        const prevHashes = prevVec.hashes;
        const prevHashById = new Map();
        if (!prevHashes && previousSkills) {
            for (const s of previousSkills)
                prevHashById.set(s.id, textHash(skillText(s)));
        }
        for (let i = 0; i < prevVec.ids.length; i++) {
            const h = prevHashes?.[i] ?? prevHashById.get(prevVec.ids[i]);
            if (h && !reusable.has(h)) {
                reusable.set(h, Array.from(prevVec.data.subarray(i * prevVec.dim, (i + 1) * prevVec.dim)));
            }
        }
    }
    const texts = skills.map(skillText);
    const hashes = texts.map(textHash);
    const rows = new Array(skills.length);
    const missingIdx = [];
    let reused = 0;
    for (let i = 0; i < skills.length; i++) {
        const hit = reusable.get(hashes[i]);
        if (hit) {
            rows[i] = hit;
            reused++;
        }
        else
            missingIdx.push(i);
    }
    for (let i = 0; i < missingIdx.length; i += 64) {
        const batch = missingIdx.slice(i, i + 64);
        const vecs = await embed(batch.map((idx) => texts[idx]), allowRemote, "doc");
        for (let j = 0; j < batch.length; j++)
            rows[batch[j]] = vecs[j];
    }
    return { rows, hashes, reused };
}
export function vectorsExist() { return fs.existsSync(META_FILE); }
/** The model the stored vectors were built with, when it is not the current one (doctor says to rebuild). */
export function vectorsBuiltWith() {
    try {
        const m = JSON.parse(fs.readFileSync(META_FILE, "utf8")).model;
        return typeof m === "string" && m !== MODEL_TAG ? m : undefined;
    }
    catch {
        return undefined;
    }
}
let vectors;
let vectorsStamp;
function vecStamp() {
    try {
        const m = fs.statSync(META_FILE), v = fs.statSync(VEC_FILE);
        return `${m.mtimeMs}:${m.size}|${v.mtimeMs}:${v.size}`;
    }
    catch {
        return "-";
    }
}
/** Forget the loaded vectors (the warm service does this when the embedding files change on disk). */
export function resetVectors() { vectors = undefined; vectorsStamp = undefined; }
export function loadVectors() {
    const stamp = vecStamp();
    if (vectors !== undefined && vectorsStamp === stamp)
        return vectors;
    vectorsStamp = stamp;
    try {
        const meta = JSON.parse(fs.readFileSync(META_FILE, "utf8"));
        const buf = fs.readFileSync(VEC_FILE);
        const data = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
        if (meta.model !== MODEL_TAG || data.length !== meta.count * meta.dim)
            throw new Error("stale");
        vectors = { ids: meta.ids, dim: meta.dim, data, index: new Map(meta.ids.map((id, i) => [id, i])), indexBuiltAt: meta.indexBuiltAt, ...(Array.isArray(meta.hashes) ? { hashes: meta.hashes } : {}) };
    }
    catch {
        vectors = null;
    }
    return vectors;
}
/** Cosine of the query against every skill (vectors are normalized, so a dot product). */
export function cosines(q, v) {
    const out = new Map();
    for (let i = 0; i < v.ids.length; i++) {
        let s = 0;
        const off = i * v.dim;
        for (let j = 0; j < v.dim; j++)
            s += q[j] * v.data[off + j];
        out.set(v.ids[i], s + COS_SHIFT);
    }
    return out;
}
/** A query's vector: from the warm service when this process is not it, else (or when it cannot answer) locally. */
async function queryVector(query, budgetMs) {
    if (!local && serviceEnabled()) {
        const out = await askService("-", "embed", query.slice(0, 4000), budgetMs).catch(() => null);
        if (out) {
            try {
                const v = JSON.parse(out);
                if (Array.isArray(v) && v.length && v.every((x) => typeof x === "number"))
                    return [v];
            }
            catch { /* fall through */ }
        }
    }
    return embed([query]);
}
/**
 * The query's cosines within a time budget. `status` says why there are none: no vectors ("off"),
 * vectors built for another index ("stale"), too slow ("timeout") or no model ("error"); callers
 * then use the lexical gate.
 */
export async function semanticScores(query, budgetMs = 800, indexBuiltAt) {
    const v = loadVectors();
    if (!v)
        return { scores: null, status: "off" };
    if (indexBuiltAt && v.indexBuiltAt !== indexBuiltAt)
        return { scores: null, status: "stale" };
    let timer;
    try {
        const q = await Promise.race([queryVector(query, budgetMs), new Promise((r) => { timer = setTimeout(() => r(null), budgetMs); timer.unref(); })]);
        return q ? { scores: cosines(q[0], v), status: "on" } : { scores: null, status: "timeout" };
    }
    catch (e) {
        return { scores: null, status: "error", error: String(e?.message ?? e).split("\n")[0].slice(0, 200) };
    }
    finally {
        clearTimeout(timer);
    }
}
