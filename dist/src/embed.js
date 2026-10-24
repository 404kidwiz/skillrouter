import fs from "node:fs";
import path from "node:path";
import { SR_DIR } from "./paths.js";
import { renameSyncRetry } from "./platform.js";
// Optional semantic layer: MiniLM vectors for every skill's name + description, stored as one
// Float32 file beside the index so a hook process reads it in milliseconds. Needs the optional
// peer dependency @huggingface/transformers; everything degrades to lexical when it is missing.
export const MODEL = "Xenova/all-MiniLM-L6-v2";
export const MODELS_DIR = path.join(SR_DIR, "models");
const VEC_FILE = path.join(SR_DIR, "embeddings.f32");
const META_FILE = path.join(SR_DIR, "embeddings.json");
/** The files the vectors live in, for anything that watches them for changes. */
export const VECTOR_FILES = [META_FILE, VEC_FILE];
let pipe = null; // the promise, so concurrent first calls load the model once
/** Embed texts with the local model. `allowRemote` permits the one-time download (index time only, never in a hook). */
export async function embed(texts, allowRemote = false) {
    pipe ??= (async () => {
        const mod = await import("@huggingface/transformers").catch(() => {
            throw new Error("Embeddings need @huggingface/transformers installed next to skillrouter (npm i @huggingface/transformers).");
        });
        mod.env.cacheDir = MODELS_DIR;
        mod.env.allowRemoteModels = allowRemote;
        return (await mod.pipeline("feature-extraction", MODEL));
    })();
    const p = pipe;
    try {
        const out = await (await p)(texts, { pooling: "mean", normalize: true });
        return out.tolist();
    }
    catch (e) {
        if (pipe === p)
            pipe = null;
        throw e;
    }
}
export function skillText(s) {
    return `${s.name.replace(/[-_~]/g, " ")}: ${s.description}`.slice(0, 512);
}
/** Vectors are stamped with the index they were built for; any other index makes them stale. */
export function saveVectors(ids, rows, indexBuiltAt) {
    const dim = rows[0]?.length ?? 0;
    const data = new Float32Array(ids.length * dim);
    rows.forEach((r, i) => data.set(r, i * dim));
    fs.mkdirSync(SR_DIR, { recursive: true });
    fs.writeFileSync(VEC_FILE + ".tmp", Buffer.from(data.buffer));
    fs.writeFileSync(META_FILE + ".tmp", JSON.stringify({ model: MODEL, dim, count: ids.length, builtAt: new Date().toISOString(), indexBuiltAt, ids }));
    renameSyncRetry(VEC_FILE + ".tmp", VEC_FILE);
    renameSyncRetry(META_FILE + ".tmp", META_FILE);
}
export function vectorsExist() { return fs.existsSync(META_FILE); }
let vectors;
/** Forget the loaded vectors (the warm service does this when the embedding files change on disk). */
export function resetVectors() { vectors = undefined; }
export function loadVectors() {
    if (vectors !== undefined)
        return vectors;
    try {
        const meta = JSON.parse(fs.readFileSync(META_FILE, "utf8"));
        const buf = fs.readFileSync(VEC_FILE);
        const data = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
        if (meta.model !== MODEL || data.length !== meta.count * meta.dim)
            throw new Error("stale");
        vectors = { ids: meta.ids, dim: meta.dim, data, index: new Map(meta.ids.map((id, i) => [id, i])), indexBuiltAt: meta.indexBuiltAt };
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
        out.set(v.ids[i], s);
    }
    return out;
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
        const q = await Promise.race([embed([query]), new Promise((r) => { timer = setTimeout(() => r(null), budgetMs); timer.unref(); })]);
        return q ? { scores: cosines(q[0], v), status: "on" } : { scores: null, status: "timeout" };
    }
    catch {
        return { scores: null, status: "error" };
    }
    finally {
        clearTimeout(timer);
    }
}
