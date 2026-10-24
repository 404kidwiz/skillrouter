import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { AGENT_SKILL_DIRS, HOME } from "./paths.js";
import { NO_WINDOW, renameSyncRetry, tarCommand } from "./platform.js";
export function hashFile(file) {
    const hash = createHash("sha256"), fd = fs.openSync(file, "r"), buf = Buffer.allocUnsafe(64 * 1024);
    try {
        let n;
        while ((n = fs.readSync(fd, buf, 0, buf.length, null)))
            hash.update(buf.subarray(0, n));
    }
    finally {
        fs.closeSync(fd);
    }
    return hash.digest("hex");
}
/** Snapshot metadata never follows links: external library contents are not part of this backup. */
export function backupEntries(source) {
    const out = [];
    const visit = (rel) => {
        const file = path.join(source, rel), st = fs.lstatSync(file);
        const name = rel.split(path.sep).join("/");
        if (!portable(name))
            throw new Error(`Backup path is not portable: ${file}`);
        if (st.isSymbolicLink()) {
            let directory = true;
            try {
                directory = fs.statSync(file).isDirectory();
            }
            catch { /* a dangling skill-folder link is still a directory link */ }
            out.push({ path: name, type: "symlink", target: fs.readlinkSync(file), directory });
        }
        else if (st.isDirectory()) {
            out.push({ path: name, type: "directory", mode: st.mode & 0o777 });
            for (const child of fs.readdirSync(file).sort())
                visit(path.join(rel, child));
        }
        else if (st.isFile())
            out.push({ path: name, type: "file", mode: st.mode & 0o777, sha256: hashFile(file) });
        else
            throw new Error(`Cannot safely back up special file: ${file}`);
    };
    visit("");
    return out;
}
export function writeRestoreManifest(file, manifest) {
    fs.writeFileSync(file + ".tmp", JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 });
    renameSyncRetry(file + ".tmp", file);
}
function lstat(file) {
    try {
        return fs.lstatSync(file);
    }
    catch (e) {
        if (e.code === "ENOENT")
            return null;
        throw e;
    }
}
const digest = (s) => typeof s === "string" && /^[a-f0-9]{64}$/.test(s);
const portable = (s) => typeof s === "string" && !s.includes("\\") && !/[\0\r\n:]/.test(s) && !s.startsWith("/") && (s === "" || s.split("/").every((p) => !!p && p !== "." && p !== ".."));
function readManifest(file) {
    const m = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
    if ((m?.version !== 1 && m?.version !== 2) || !Array.isArray(m.backups))
        throw new Error("Unsupported restore manifest (expected version 1 or 2).");
    const allowed = new Set(Object.values(AGENT_SKILL_DIRS).flat().map((p) => path.resolve(p)));
    const sources = new Set();
    for (const b of m.backups) {
        if (!b || typeof b.source !== "string" || !path.isAbsolute(b.source) || !allowed.has(path.resolve(b.source)) || sources.has(path.resolve(b.source)))
            throw new Error("Restore source must be a unique agent skill folder in this user's home.");
        sources.add(path.resolve(b.source));
        if (typeof b.archive !== "string" || path.basename(b.archive) !== b.archive || !/\.tar$/.test(b.archive) || !digest(b.sha256) || !Array.isArray(b.entries))
            throw new Error("Invalid backup record.");
        const entries = new Map();
        for (const e of b.entries) {
            if (!e || !portable(e.path) || entries.has(e.path))
                throw new Error("Invalid or duplicate backup entry path.");
            if (e.type === "symlink") {
                if (typeof e.target !== "string" || !e.target || e.target.includes("\0") || typeof e.directory !== "boolean")
                    throw new Error("Invalid backup link.");
            }
            else if (e.type === "directory" || e.type === "file") {
                if (!Number.isInteger(e.mode) || e.mode < 0 || e.mode > 0o777 || (e.type === "file" && !digest(e.sha256)))
                    throw new Error("Invalid backup file metadata.");
            }
            else
                throw new Error("Unsupported backup entry type.");
            entries.set(e.path, e);
        }
        if (entries.get("")?.type !== "directory")
            throw new Error("Backup root must be a directory.");
        if (m.version === 2) {
            if (!Array.isArray(b.removed) || new Set(b.removed).size !== b.removed.length || b.removed.some((n) => typeof n !== "string" || !n || n.includes("/") || !entries.has(n)))
                throw new Error("Invalid list of removed entries.");
        }
        else
            delete b.removed;
        for (const e of b.entries)
            if (e.path) {
                const parent = path.posix.dirname(e.path);
                if (entries.get(parent === "." ? "" : parent)?.type !== "directory")
                    throw new Error("Backup entry has a missing or linked parent.");
            }
        const archive = path.join(path.dirname(file), b.archive), st = lstat(archive);
        if (!st?.isFile() || st.isSymbolicLink() || hashFile(archive) !== b.sha256)
            throw new Error(`Backup archive missing or changed: ${b.archive}`);
    }
    return m;
}
/** Existing directory links must never turn a restore into writes outside the intended tree. */
function checkParents(source, rel, create = false) {
    const destination = path.join(source, rel), parent = path.dirname(destination);
    const segments = path.relative(HOME, parent).split(path.sep).filter(Boolean);
    let at = HOME;
    for (const segment of segments) {
        at = path.join(at, segment);
        const st = lstat(at);
        if (st && (!st.isDirectory() || st.isSymbolicLink()))
            throw new Error(`Agent skill parent is not a real directory: ${at}`);
        if (!st && create)
            fs.mkdirSync(at, { mode: 0o700 });
    }
}
/** Trim must reject every source that restoration would refuse, before moving any requested folder. */
export function checkBackupSource(source) {
    checkParents(source, "");
    const st = lstat(source);
    if (!st || st.isSymbolicLink())
        return false; // trim has always skipped linked skill-folder roots
    if (!st.isDirectory())
        throw new Error(`Agent skill source is not a real directory: ${source}`);
    return true;
}
function sameEntry(file, e) {
    const st = lstat(file);
    if (!st)
        return false;
    if (e.type === "directory")
        return st.isDirectory() && !st.isSymbolicLink();
    if (e.type === "file")
        return st.isFile() && !st.isSymbolicLink() && hashFile(file) === e.sha256;
    if (!st.isSymbolicLink())
        return false;
    return path.resolve(path.dirname(file), fs.readlinkSync(file)) === path.resolve(path.dirname(file), e.target);
}
/** A staged copy is usable only as a regular file inside staging (no link anywhere on its path) with the recorded bytes. */
function stagedFile(file, stageRoot, sha256) {
    const st = lstat(file);
    if (!st?.isFile() || st.isSymbolicLink())
        return false;
    const real = fs.realpathSync(file);
    return real === path.resolve(file) && real.startsWith(stageRoot + path.sep) && hashFile(file) === sha256;
}
/** Extracted archives can hold read-only folders (a backed-up 0555 directory): open them up so staging can be removed. */
function makeRemovable(dir) {
    const st = lstat(dir);
    if (!st?.isDirectory() || st.isSymbolicLink())
        return;
    try {
        fs.chmodSync(dir, 0o700);
    }
    catch { /* best effort */ }
    for (const child of fs.readdirSync(dir))
        makeRemovable(path.join(dir, child));
}
const depth = (e) => (e.path ? e.path.split("/").length : 0);
/**
 * Bring back what trim removed, skill by skill (a skill is one top-level entry of an agent folder). Missing entries are
 * added; identical ones are left alone; a skill that has changed since the trim (edited, re-added by `core sync`, replaced)
 * is skipped as a whole and reported, so nothing is ever overwritten and no skill ends up half old, half new. Entries trim
 * kept are not touched at all, so later edits or deliberate deletions of them stand.
 *
 * Each archive is extracted once into private staging next to the backups (one pass, whatever the number of files), and a
 * file is used only if it is a regular file inside staging whose bytes match the manifest; the agent folders change only
 * after every needed file is verified. A problem with an agent folder itself (replaced by a link, not a directory) or with
 * the manifest or an archive stops the whole restore before anything is written.
 */
export function restore(file, apply = false) {
    file = path.resolve(file);
    const manifest = readManifest(file);
    const stats = { missing: 0, unchanged: 0, restored: 0, kept: 0, conflicts: [], sources: manifest.backups.map((b) => b.source) };
    const missing = [];
    for (const backup of manifest.backups) {
        checkParents(backup.source, "");
        const root = lstat(backup.source);
        if (root && (!root.isDirectory() || root.isSymbolicLink()))
            throw new Error(`Agent skill folder is not a real directory: ${backup.source}`);
        const removed = backup.removed ? new Set(backup.removed) : null;
        const skills = new Map();
        for (const e of backup.entries)
            if (e.path) {
                const name = e.path.split("/")[0];
                if (!skills.has(name))
                    skills.set(name, []);
                skills.get(name).push(e);
            }
        const found = [];
        for (const [name, entries] of skills) {
            if (removed && !removed.has(name)) {
                stats.kept++;
                continue;
            }
            const todo = [], changed = [];
            let same = 0;
            for (const entry of [...entries].sort((a, b) => depth(a) - depth(b))) {
                if (changed.some((c) => entry.path.startsWith(c + "/")))
                    continue; // below a changed folder: already reported
                const destination = path.join(backup.source, entry.path);
                let st;
                try {
                    checkParents(backup.source, entry.path);
                    st = lstat(destination);
                }
                catch {
                    changed.push(entry.path);
                    continue;
                }
                if (!st)
                    todo.push({ backup, entry, destination, name });
                else if (sameEntry(destination, entry))
                    same++;
                else
                    changed.push(entry.path);
            }
            if (changed.length) {
                stats.conflicts.push({ source: backup.source, name, paths: changed });
                continue;
            }
            stats.unchanged += same;
            found.push(...todo);
        }
        if (root)
            stats.unchanged++;
        else if (found.length)
            found.unshift({ backup, entry: backup.entries.find((e) => e.path === ""), destination: backup.source, name: "" });
        stats.missing += found.length;
        missing.push(...found);
    }
    if (!apply || !missing.length)
        return stats;
    const stage = fs.mkdtempSync(path.join(path.dirname(file), ".restore-"));
    try {
        const stageRoot = fs.realpathSync(stage);
        // One extraction per archive that has files to restore. Links in an archive may not extract (Windows needs a privilege
        // for them) and tar then reports failure; that is fine as long as every file this restore needs is there and verified.
        const archives = new Map();
        for (const item of missing)
            if (item.entry.type === "file") {
                if (!archives.has(item.backup))
                    archives.set(item.backup, []);
                archives.get(item.backup).push(item);
            }
        let n = 0;
        for (const [backup, items] of archives) {
            const into = path.join(stageRoot, String(n++)); // resolved: the link check below compares real paths
            fs.mkdirSync(into);
            // Relative archive path, run from the staging folder: tar's arguments stay ASCII whatever the home folder is called (see trim).
            const tar = spawnSync(tarCommand(), ["-xf", path.relative(into, path.join(path.dirname(file), backup.archive))], { ...NO_WINDOW, cwd: into, stdio: ["ignore", "ignore", "pipe"], encoding: "utf8" });
            if (tar.error)
                throw new Error(`Could not run tar to read ${backup.archive}: ${tar.error.message}`);
            const base = path.join(into, path.basename(backup.source));
            for (const item of items) {
                const entry = item.entry;
                const own = path.join(base, ...entry.path.split("/"));
                // A hardlinked copy may only be in the archive under its first name: any entry with the same verified bytes will do.
                // (Looked for only when needed: scanning every entry for every file would make large restores quadratic.)
                item.staged = stagedFile(own, stageRoot, entry.sha256) ? own : backup.entries
                    .filter((e) => e.type === "file" && e.path !== entry.path && e.sha256 === entry.sha256)
                    .map((c) => path.join(base, ...c.path.split("/"))).find((f) => stagedFile(f, stageRoot, entry.sha256));
                if (!item.staged)
                    throw new Error(`Backup content does not match manifest: ${entry.path}${tar.status ? ` (tar: ${String(tar.stderr).trim().split("\n")[0]})` : ""}`);
            }
        }
        const created = [];
        const skipped = new Set(); // source + skill that changed while restoring: the rest of that skill is left alone
        const key = (item) => `${item.backup.source}\0${item.name}`;
        for (const item of missing.sort((a, b) => depth(a.entry) - depth(b.entry))) {
            if (skipped.has(key(item)))
                continue;
            checkParents(item.backup.source, item.entry.path, true);
            if (lstat(item.destination)) {
                if (sameEntry(item.destination, item.entry))
                    continue; // an identical entry appeared after the preview
                if (!item.name)
                    throw new Error(`Agent skill folder changed during restore: ${item.destination}`);
                skipped.add(key(item));
                stats.conflicts.push({ source: item.backup.source, name: item.name, paths: [item.entry.path] });
                continue;
            }
            if (item.entry.type === "directory") {
                fs.mkdirSync(item.destination, { mode: 0o700 });
                created.push(item);
            }
            else if (item.entry.type === "symlink") {
                const junction = process.platform === "win32" && item.entry.directory;
                const target = junction ? path.resolve(path.dirname(item.destination), item.entry.target) : item.entry.target;
                fs.symlinkSync(target, item.destination, junction ? "junction" : item.entry.directory ? "dir" : "file");
            }
            else {
                fs.copyFileSync(item.staged, item.destination, fs.constants.COPYFILE_EXCL);
                fs.chmodSync(item.destination, item.entry.mode);
            }
            stats.restored++;
        }
        // Apply directory modes last so a read-only backup directory cannot block its own children being restored.
        for (const item of created)
            if (item.entry.type === "directory")
                fs.chmodSync(item.destination, item.entry.mode);
    }
    finally {
        makeRemovable(stage);
        fs.rmSync(stage, { recursive: true, force: true });
    }
    return stats;
}
