import fs from "node:fs";
import path from "node:path";
import { BACKUP_DIR } from "./paths.js";
/**
 * What is in ~/.skillrouter/backups and what `skillrouter backups --apply` would remove. Nothing here is ever
 * deleted on its own: these are the only way back from a trim. Kept regardless of age: the newest restore manifest
 * (RESTORE-*.json), its notes and every archive it names, because that is the trim a restore would undo; and anything
 * newer than `days`. The rest (older trims, config and rule snapshots made along the way) is offered for removal.
 */
export function backupPlan(days = 30, dir = BACKUP_DIR, now = Date.now()) {
    let names;
    try {
        names = fs.readdirSync(dir).sort();
    }
    catch {
        return [];
    }
    const size = (p) => { try {
        const st = fs.lstatSync(p);
        if (!st.isDirectory())
            return st.size;
        return fs.readdirSync(p).reduce((n, f) => n + size(path.join(p, f)), 0);
    }
    catch {
        return 0;
    } };
    // Newest by the time written, then by name: a restore manifest's name carries its timestamp.
    const manifests = names.filter((n) => /^RESTORE-.*\.json$/.test(n)).map((n) => ({ n, t: mtime(path.join(dir, n)) })).sort((a, b) => b.t - a.t || (a.n < b.n ? 1 : -1));
    const protectedNames = new Map();
    const newest = manifests[0]?.n;
    if (newest) {
        protectedNames.set(newest, "newest restore manifest");
        protectedNames.set(newest.replace(/\.json$/, ".md"), "notes of the newest restore manifest");
        try {
            const m = JSON.parse(fs.readFileSync(path.join(dir, newest), "utf8"));
            for (const b of Array.isArray(m?.backups) ? m.backups : [])
                if (typeof b?.archive === "string")
                    protectedNames.set(path.basename(b.archive), "archive of the newest restore manifest");
        }
        catch {
            protectedNames.set("*", "newest restore manifest is unreadable: nothing is offered for removal");
        }
    }
    return names.map((name) => {
        const file = path.join(dir, name), ageDays = Math.max(0, (now - mtime(file)) / 86400e3);
        const keep = protectedNames.get(name) ?? protectedNames.get("*") ?? (ageDays < days ? `newer than ${days} days` : undefined);
        return { name, bytes: size(file), ageDays: Math.round(ageDays * 10) / 10, ...(keep ? { keep } : {}) };
    });
}
/** The newest change anywhere inside (a folder's own time does not move when a file in it is rewritten). */
function mtime(p) {
    try {
        const st = fs.lstatSync(p);
        if (!st.isDirectory())
            return st.mtimeMs;
        return fs.readdirSync(p).reduce((t, f) => Math.max(t, mtime(path.join(p, f))), st.mtimeMs);
    }
    catch {
        return Date.now();
    } // unreadable: treated as new, so it is kept
}
/** Remove what the plan does not keep. Returns the names removed and those that could not be. */
export function pruneBackups(plan, dir = BACKUP_DIR) {
    const removed = [], failed = [];
    for (const item of plan) {
        if (item.keep)
            continue;
        if (item.name.includes("/") || item.name.includes("\\") || item.name === "." || item.name === "..") {
            failed.push(item.name);
            continue;
        }
        try {
            fs.rmSync(path.join(dir, item.name), { recursive: true, force: true });
            removed.push(item.name);
        }
        catch {
            failed.push(item.name);
        }
    }
    return { removed, failed };
}
export function formatBackups(plan, days, applied) {
    const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;
    if (!plan.length)
        return "No backups.";
    const lines = plan.map((i) => `  ${mb(i.bytes).padStart(9)}  ${String(i.ageDays).padStart(6)} d  ${i.keep ? `keep (${i.keep})` : applied ? (applied.removed.includes(i.name) ? "REMOVED" : "could not remove") : "would remove"}  ${i.name}`);
    const gone = plan.filter((i) => !i.keep), total = plan.reduce((n, i) => n + i.bytes, 0), freed = gone.reduce((n, i) => n + i.bytes, 0);
    return [`Backups in ${BACKUP_DIR}: ${plan.length} entries, ${mb(total)}`, ...lines,
        applied ? `Removed ${applied.removed.length} entries (${mb(freed)}).${applied.failed.length ? ` Could not remove: ${applied.failed.join(", ")}` : ""}`
            : gone.length ? `Dry run: ${gone.length} entries older than ${days} days (${mb(freed)}) would be removed. Add --apply to remove them; removal is permanent.` : `Nothing older than ${days} days to remove.`].join("\n");
}
