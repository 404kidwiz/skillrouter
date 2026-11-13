import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
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

type Pipe = (t: string[], o: object) => Promise<{ tolist(): number[][] }>;
let pipe: Promise<Pipe> | null = null; // the promise, so concurrent first calls load the model once
/** Why the last embedding attempt failed, for doctor and the usage log; cleared by a success. */
export let lastEmbedError: string | undefined;

/**
 * The ES entry of an installed package, by its real path. Node can reach a package through a link (pnpm's layout, a
 * linked checkout) and, in some processes on Node 26, import it under the link path, where it cannot see its own
 * dependencies beside it in the store ("Cannot find package 'onnxruntime-common'"). The real path always can.
 */
export function packageEntry(name: string, from = import.meta.url): string {
  const req = createRequire(from);
  let dir = path.dirname(fs.realpathSync(req.resolve(name)));
  const manifest = () => { try { return JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")); } catch { return null; } };
  let pkg = manifest();
  while (pkg?.name !== name) { const up = path.dirname(dir); if (up === dir) throw new Error(`${name}: package root not found`); dir = up; pkg = manifest(); }
  const pick = (x: unknown): string | undefined => typeof x === "string" ? x : x && typeof x === "object" ? (pick((x as any).node) ?? pick((x as any).import) ?? pick((x as any).default)) : undefined;
  const entry = pick(pkg.exports?.["."] ?? pkg.exports) ?? pkg.module ?? pkg.main ?? "index.js";
  return pathToFileURL(path.join(dir, entry)).href;
}

/** Embed texts with the local model. `allowRemote` permits the one-time download (index time only, never in a hook). */
export async function embed(texts: string[], allowRemote = false): Promise<number[][]> {
  pipe ??= (async () => {
    const mod: any = await import(packageEntry("@huggingface/transformers")).catch((e) => {
      throw new Error(`Embeddings need @huggingface/transformers installed next to skillrouter (npm i @huggingface/transformers): ${String(e?.message ?? e).split("\n")[0].slice(0, 160)}`);
    });
    mod.env.cacheDir = MODELS_DIR;
    mod.env.allowRemoteModels = allowRemote;
    return (await mod.pipeline("feature-extraction", MODEL)) as Pipe;
  })();
  const p = pipe;
  try {
    const out = await (await p)(texts, { pooling: "mean", normalize: true });
    lastEmbedError = undefined;
    return out.tolist();
  } catch (e) { if (pipe === p) pipe = null; lastEmbedError = String((e as Error)?.message ?? e).split("\n")[0].slice(0, 200); throw e; }
}

export function skillText(s: { name: string; description: string }): string {
  return `${s.name.replace(/[-_~]/g, " ")}: ${s.description}`.slice(0, 512);
}

export function textHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

export interface Vectors { ids: string[]; dim: number; data: Float32Array; index: Map<string, number>; indexBuiltAt?: string; hashes?: string[] }

/** Vectors are stamped with the index they were built for; any other index makes them stale. */
export function saveVectors(ids: string[], rows: number[][], indexBuiltAt: string, hashes?: string[]): void {
  const dim = rows[0]?.length ?? 0;
  const data = new Float32Array(ids.length * dim);
  rows.forEach((r, i) => data.set(r, i * dim));
  fs.mkdirSync(SR_DIR, { recursive: true });
  fs.writeFileSync(VEC_FILE + ".tmp", Buffer.from(data.buffer));
  fs.writeFileSync(META_FILE + ".tmp", JSON.stringify({ model: MODEL, dim, count: ids.length, builtAt: new Date().toISOString(), indexBuiltAt, ids, ...(hashes ? { hashes } : {}) }));
  renameSyncRetry(VEC_FILE + ".tmp", VEC_FILE);
  renameSyncRetry(META_FILE + ".tmp", META_FILE);
}

/** Embed only skills whose text changed since the previous vector build; reuse unchanged Float32 rows. */
export async function embedSkills(
  skills: { id: string; name: string; description: string }[],
  previousSkills?: { id: string; name: string; description: string }[],
  allowRemote = true,
): Promise<{ rows: number[][]; hashes: string[]; reused: number }> {
  const prevVec = loadVectors();
  const reusable = new Map<string, number[]>();
  if (prevVec && prevVec.dim > 0) {
    const prevHashes = prevVec.hashes;
    const prevHashById = new Map<string, string>();
    if (!prevHashes && previousSkills) {
      for (const s of previousSkills) prevHashById.set(s.id, textHash(skillText(s)));
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
  const rows: number[][] = new Array(skills.length);
  const missingIdx: number[] = [];
  let reused = 0;
  for (let i = 0; i < skills.length; i++) {
    const hit = reusable.get(hashes[i]);
    if (hit) { rows[i] = hit; reused++; }
    else missingIdx.push(i);
  }
  for (let i = 0; i < missingIdx.length; i += 64) {
    const batch = missingIdx.slice(i, i + 64);
    const vecs = await embed(batch.map((idx) => texts[idx]), allowRemote);
    for (let j = 0; j < batch.length; j++) rows[batch[j]] = vecs[j];
  }
  return { rows, hashes, reused };
}

export function vectorsExist(): boolean { return fs.existsSync(META_FILE); }

let vectors: Vectors | null | undefined;
let vectorsStamp: string | undefined;
function vecStamp(): string {
  try {
    const m = fs.statSync(META_FILE), v = fs.statSync(VEC_FILE);
    return `${m.mtimeMs}:${m.size}|${v.mtimeMs}:${v.size}`;
  } catch { return "-"; }
}
/** Forget the loaded vectors (the warm service does this when the embedding files change on disk). */
export function resetVectors(): void { vectors = undefined; vectorsStamp = undefined; }
export function loadVectors(): Vectors | null {
  const stamp = vecStamp();
  if (vectors !== undefined && vectorsStamp === stamp) return vectors;
  vectorsStamp = stamp;
  try {
    const meta = JSON.parse(fs.readFileSync(META_FILE, "utf8"));
    const buf = fs.readFileSync(VEC_FILE);
    const data = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
    if (meta.model !== MODEL || data.length !== meta.count * meta.dim) throw new Error("stale");
    vectors = { ids: meta.ids, dim: meta.dim, data, index: new Map(meta.ids.map((id: string, i: number) => [id, i])), indexBuiltAt: meta.indexBuiltAt, ...(Array.isArray(meta.hashes) ? { hashes: meta.hashes } : {}) };
  } catch { vectors = null; }
  return vectors;
}

/** Cosine of the query against every skill (vectors are normalized, so a dot product). */
export function cosines(q: number[], v: Vectors): Map<string, number> {
  const out = new Map<string, number>();
  for (let i = 0; i < v.ids.length; i++) {
    let s = 0;
    const off = i * v.dim;
    for (let j = 0; j < v.dim; j++) s += q[j] * v.data[off + j];
    out.set(v.ids[i], s);
  }
  return out;
}

export type SemanticStatus = "on" | "off" | "stale" | "timeout" | "error";

/**
 * The query's cosines within a time budget. `status` says why there are none: no vectors ("off"),
 * vectors built for another index ("stale"), too slow ("timeout") or no model ("error"); callers
 * then use the lexical gate.
 */
export async function semanticScores(query: string, budgetMs = 800, indexBuiltAt?: string): Promise<{ scores: Map<string, number> | null; status: SemanticStatus; error?: string }> {
  const v = loadVectors();
  if (!v) return { scores: null, status: "off" };
  if (indexBuiltAt && v.indexBuiltAt !== indexBuiltAt) return { scores: null, status: "stale" };
  let timer: NodeJS.Timeout | undefined;
  try {
    const q = await Promise.race([embed([query]), new Promise<null>((r) => { timer = setTimeout(() => r(null), budgetMs); timer.unref(); })]);
    return q ? { scores: cosines(q[0], v), status: "on" } : { scores: null, status: "timeout" };
  } catch (e) { return { scores: null, status: "error", error: String((e as Error)?.message ?? e).split("\n")[0].slice(0, 200) }; } finally { clearTimeout(timer); }
}
