import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { NO_WINDOW, linkDir, renameSyncRetry, tarCommand } from "./platform.js";
import { AGENT_SKILL_DIRS, BACKUP_DIR, LIBRARY_DIR } from "./paths.js";
import { readCore } from "./core.js";
import { backupEntries, checkBackupSource, hashFile, writeRestoreManifest } from "./restore.js";
function realOrNull(p) { try {
    return fs.realpathSync(p);
}
catch {
    return null;
} }
function isPluginFolder(p) {
    return fs.existsSync(path.join(p, ".claude-plugin", "plugin.json"));
}
/**
 * Move everything that is not core out of the agents' auto-load folders into the library.
 * Real folders move; symlinks are re-created in the library and removed from the agent folder;
 * dangling links are dropped. Plugin-format folders (Claude) and dot entries stay. Each folder
 * is tarred into ~/.skillrouter/backups first; the manifest drives collision-safe restoration.
 */
export function trim(agents, apply, keep = []) {
    const stats = { moved: 0, linked: 0, dangling: 0, kept: 0, conflicts: 0, backups: [] };
    const keepSet = new Set([...readCore(), ...keep]);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const manifest = { version: 2, createdAt: new Date().toISOString(), backups: [] };
    const sources = [...new Set(agents.flatMap((a) => AGENT_SKILL_DIRS[a]))];
    const dirs = sources.filter(checkBackupSource);
    if (apply) {
        fs.mkdirSync(LIBRARY_DIR, { recursive: true });
        fs.mkdirSync(BACKUP_DIR, { recursive: true });
        stats.manifest = path.join(BACKUP_DIR, `RESTORE-${stamp}.json`);
        writeRestoreManifest(stats.manifest, manifest);
        const posix = "'" + stats.manifest.replace(/'/g, "'\\''") + "'";
        const powershell = "'" + stats.manifest.replace(/'/g, "''") + "'";
        fs.writeFileSync(path.join(BACKUP_DIR, `RESTORE-${stamp}.md`), `# Undo trim ${stamp}\n\nKeep the agent folders in place. The restore command adds missing files and refuses changed collisions. Choose your shell below; first preview, then apply.\n\n## POSIX shells (sh, bash, zsh)\n\n\`\`\`sh\nskillrouter restore ${posix}\nskillrouter restore ${posix} --apply\n\`\`\`\n\n## PowerShell (Windows, macOS, Linux)\n\n\`\`\`powershell\nskillrouter restore ${powershell}\nskillrouter restore ${powershell} --apply\n\`\`\`\n\nThese commands are not for cmd.exe; use PowerShell on Windows. The JSON manifest records each archive's original folder and checksum. Use only your own trusted backup manifest.\n`);
    }
    // Names already in the library, plus ones this run will add (so a dry run counts like a real one).
    const taken = new Map(fs.existsSync(LIBRARY_DIR) ? fs.readdirSync(LIBRARY_DIR).map((n) => [n, realOrNull(path.join(LIBRARY_DIR, n))]) : []);
    for (const dir of dirs) {
        // Decide every top-level entry first: what trim removes (folders move, links are re-created in the library, broken
        // links are dropped) is all that restore may later bring back. Kept entries are the user's to change.
        const plan = fs.readdirSync(dir).map((name) => {
            const p = path.join(dir, name);
            if (name.startsWith(".") || keepSet.has(name) || isPluginFolder(p))
                return { name, p, lst: null };
            const lst = fs.lstatSync(p);
            return { name, p, lst: lst.isSymbolicLink() || lst.isDirectory() ? lst : null };
        });
        if (apply) {
            const tar = path.join(BACKUP_DIR, `${path.basename(path.dirname(dir))}-${path.basename(dir)}-${stamp}.tar`.replace(/^\./, ""));
            const entries = backupEntries(dir);
            execFileSync(tarCommand(), ["-cf", tar, "-C", path.dirname(dir), path.basename(dir)], NO_WINDOW);
            const removed = plan.filter((e) => e.lst).map((e) => e.name).filter((name) => entries.some((e) => e.path === name));
            manifest.backups.push({ archive: path.basename(tar), source: path.resolve(dir), sha256: hashFile(tar), removed, entries });
            // Persist recovery information before the first move, including when a later folder or move fails.
            writeRestoreManifest(stats.manifest, manifest);
            stats.backups.push(tar);
        }
        for (const { name, p, lst } of plan) {
            if (!lst) {
                stats.kept++;
                continue;
            }
            const dest = path.join(LIBRARY_DIR, name);
            if (lst.isSymbolicLink()) {
                let target;
                try {
                    target = fs.realpathSync(p);
                }
                catch {
                    stats.dangling++;
                    if (apply)
                        fs.unlinkSync(p);
                    continue;
                }
                if (!taken.has(name)) {
                    if (apply)
                        linkDir(target, dest);
                    taken.set(name, target);
                    stats.linked++;
                }
                else if (taken.get(name) !== target) {
                    const alt = path.join(LIBRARY_DIR, ".conflicts", path.basename(path.dirname(dir)), name);
                    if (apply) {
                        fs.mkdirSync(path.dirname(alt), { recursive: true });
                        if (!fs.existsSync(alt))
                            linkDir(target, alt);
                    }
                    stats.conflicts++;
                }
                if (apply)
                    fs.unlinkSync(p);
            }
            else if (lst.isDirectory()) {
                const to = taken.has(name) ? path.join(LIBRARY_DIR, ".conflicts", path.basename(path.dirname(dir)), name) : dest;
                if (to !== dest)
                    stats.conflicts++;
                else {
                    stats.moved++;
                    taken.set(name, apply ? dest : fs.realpathSync(p));
                }
                if (apply) {
                    fs.mkdirSync(path.dirname(to), { recursive: true });
                    renameSyncRetry(p, to);
                }
            }
        }
    }
    return stats;
}
