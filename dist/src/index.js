import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { INDEX_FILE, SR_DIR, defaultRoots } from "./paths.js";
import { tokenize, TOKENIZER_VERSION } from "./bm25.js";
import { renameSyncRetry } from "./platform.js";
const SKIP = new Set(["node_modules", ".git", ".venv", "__pycache__", "dist"]);
export function parseFrontmatter(text) {
    const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    const out = {};
    if (!m)
        return out;
    let key = "";
    for (const line of m[1].split(/\r?\n/)) {
        const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
        if (kv) {
            key = kv[1];
            out[key] = kv[2].replace(/^["'](.*)["']$/, "$1").replace(/^[>|][-+]?$/, "").trim();
        }
        else if (key && /^\s+\S/.test(line)) {
            out[key] = (out[key] + " " + line.trim()).trim(); // folded multi-line value
        }
    }
    return out;
}
function* walk(root, depth = 0) {
    if (depth > 6)
        return;
    let entries;
    try {
        entries = fs.readdirSync(root, { withFileTypes: true });
    }
    catch {
        return;
    }
    // A folder with SKILL.md is a skill; a scan root may also hold one at the top and still contain more below.
    if (entries.some((e) => e.name === "SKILL.md" && e.isFile())) {
        yield root;
        if (depth > 0)
            return;
    }
    for (const e of entries) {
        if (e.name.startsWith(".") || SKIP.has(e.name))
            continue;
        const p = path.join(root, e.name);
        let isDir = e.isDirectory();
        if (e.isSymbolicLink()) {
            try {
                isDir = fs.statSync(p).isDirectory();
            }
            catch {
                continue;
            }
        }
        if (isDir)
            yield* walk(p, depth + 1);
    }
}
export function buildIndex(extraRoots = []) {
    return buildIndexFrom(defaultRoots(extraRoots).filter((r) => fs.existsSync(r)), loadIndex() ?? undefined);
}
function digest(text) { return createHash("sha256").update(text).digest("hex"); }
function stableIdentity(name, real) {
    return `${name}@${digest(real).slice(0, 24)}`;
}
function metadataList(text, fm, keys, heading) {
    const values = [];
    for (const key of keys) {
        if (!fm[key])
            continue;
        const raw = fm[key];
        if (raw.startsWith("[")) {
            try {
                const parsed = JSON.parse(raw);
                if (Array.isArray(parsed)) {
                    values.push(...parsed.filter((v) => typeof v === "string"));
                    continue;
                }
            }
            catch { /* YAML lists also support unquoted strings. */ }
            values.push(...raw.replace(/^\[|\]$/g, "").split(/,\s*/).map(v => v.replace(/^["']|["']$/g, "")));
        }
        else
            values.push(...raw.split(/\s+-\s+/).map(v => v.replace(/^-\s*/, "")));
    }
    let active = false;
    for (const line of text.replace(/^---[\s\S]*?---/, "").split(/\r?\n/)) {
        if (/^#{1,6}\s/.test(line)) {
            active = heading.test(line.replace(/^#{1,6}\s+/, "").trim());
            continue;
        }
        if (active && line.trim())
            values.push(line.replace(/^\s*[-*]\s+/, "").trim());
    }
    const sentences = text.match(/(?:Do not use(?: this skill)? when|Use(?: this skill)? when)[^.!?\n]+[.!?]?/gi) ?? [];
    for (const sentence of sentences) {
        const negative = /^do not/i.test(sentence);
        if (negative === keys[0].startsWith("do"))
            values.push(sentence.trim());
    }
    return [...new Set(values.map(v => v.trim()).filter(Boolean))];
}
/** An index of exactly these folders. Previous alias assignments remain reserved after removal. */
export function buildIndexFrom(roots, previous) {
    const seen = new Map();
    const aliases = Object.assign(Object.create(null), previous?.identityAliases);
    const previousByPath = new Map(previous?.skills.map(s => [s.path, s]) ?? []);
    for (const skill of previous?.skills ?? []) {
        const stable = skill.stableId ?? stableIdentity(skill.name, skill.path);
        for (const alias of [skill.id, ...(skill.aliases ?? [])])
            aliases[alias] ??= stable;
    }
    // Lookup is case-insensitive: keep the first historical owner and reserve its spelling variants.
    const aliasOwners = new Map();
    for (const [alias, stable] of Object.entries(aliases)) {
        const key = alias.toLowerCase();
        if (aliasOwners.has(key)) {
            if (aliasOwners.get(key) !== stable)
                delete aliases[alias];
        }
        else
            aliasOwners.set(key, stable);
    }
    const aliasesByStable = new Map();
    for (const [alias, stable] of Object.entries(aliases)) {
        aliasesByStable.set(stable, [...(aliasesByStable.get(stable) ?? []), alias]);
    }
    for (const root of roots) {
        for (const dir of walk(root)) {
            let real;
            try {
                real = fs.realpathSync(dir);
            }
            catch {
                continue;
            }
            if (seen.has(real))
                continue;
            let text;
            try {
                text = fs.readFileSync(path.join(real, "SKILL.md"), "utf8");
            }
            catch {
                continue;
            }
            const fm = parseFrontmatter(text);
            const name = (fm.name || path.basename(dir)).trim();
            const prior = previousByPath.get(real);
            const stableId = prior?.stableId ?? stableIdentity(name, real);
            let id = prior?.id ?? name;
            let suffix = 2;
            while (aliasOwners.has(id.toLowerCase()) && aliasOwners.get(id.toLowerCase()) !== stableId)
                id = `${name}~${suffix++}`;
            if (!Object.hasOwn(aliases, id)) {
                aliases[id] = stableId;
                aliasOwners.set(id.toLowerCase(), stableId);
                aliasesByStable.set(stableId, [...(aliasesByStable.get(stableId) ?? []), id]);
            }
            const description = fm.description ?? "";
            const useWhen = metadataList(text, fm, ["useWhen", "use_when", "use-when"], /^(?:when to use|use(?: this skill)? when)\b/i);
            const doNotUseWhen = metadataList(text, fm, ["doNotUseWhen", "do_not_use_when", "do-not-use-when"], /^(?:when not to use|do not use(?: this skill)? when)\b/i);
            const priority = Number(fm.maintained_priority ?? fm["maintained-priority"] ?? fm.maintainedPriority);
            const body = text.replace(/^---[\s\S]*?---/, "").slice(0, 500);
            const head = `${name} ${description} `.repeat(3);
            seen.set(real, {
                id, stableId, aliases: aliasesByStable.get(stableId) ?? [],
                name, description, path: real, root,
                provenance: { source: fm.source || real, ...(fm.version ? { version: fm.version } : {}), contentHash: digest(text), ...(Number.isFinite(priority) ? { maintainedPriority: priority } : {}) },
                ...(useWhen.length ? { useWhen } : {}), ...(doNotUseWhen.length ? { doNotUseWhen } : {}),
                tokens: tokenize(head + body + " " + useWhen.join(" ")),
            });
        }
    }
    return { builtAt: new Date().toISOString(), roots, skills: [...seen.values()], tokenizer: TOKENIZER_VERSION, identityAliases: aliases };
}
/** Resolve canonical references and historical aliases without reassigning retired names. */
export function resolveSkillReference(index, reference) {
    const key = reference.trim().toLowerCase();
    const canonical = index.skills.find(skill => skill.stableId?.toLowerCase() === key);
    if (canonical)
        return canonical;
    const alias = Object.keys(index.identityAliases ?? {}).find(a => a.toLowerCase() === key);
    const reserved = alias ? index.identityAliases?.[alias] : undefined;
    if (reserved)
        return index.skills.find(skill => skill.stableId === reserved);
    return index.skills.find(skill => skill.id.toLowerCase() === key || skill.aliases?.some(a => a.toLowerCase() === key));
}
export function saveIndex(index) {
    fs.mkdirSync(SR_DIR, { recursive: true });
    const tmp = INDEX_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(index));
    renameSyncRetry(tmp, INDEX_FILE);
}
export function loadIndex() {
    try {
        return JSON.parse(fs.readFileSync(INDEX_FILE, "utf8"));
    }
    catch {
        return null;
    }
}
