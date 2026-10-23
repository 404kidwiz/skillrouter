import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { AGENT_SKILL_DIRS, BACKUP_DIR, LIBRARY_DIR } from "./paths.js";
import { readCore } from "./core.js";
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
 * is tarred into ~/.skillrouter/backups first; restore = untar.
 */
export function trim(agents, apply, keep = []) {
    const stats = { moved: 0, linked: 0, dangling: 0, kept: 0, conflicts: 0, backups: [] };
    const keepSet = new Set([...readCore(), ...keep]);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    if (apply) {
        fs.mkdirSync(LIBRARY_DIR, { recursive: true });
        fs.mkdirSync(BACKUP_DIR, { recursive: true });
    }
    const dirs = [...new Set(agents.flatMap((a) => AGENT_SKILL_DIRS[a]))].filter((d) => fs.existsSync(d) && !fs.lstatSync(d).isSymbolicLink());
    // Names already in the library, plus ones this run will add (so a dry run counts like a real one).
    const taken = new Map(fs.existsSync(LIBRARY_DIR) ? fs.readdirSync(LIBRARY_DIR).map((n) => [n, realOrNull(path.join(LIBRARY_DIR, n))]) : []);
    for (const dir of dirs) {
        if (apply) {
            const tar = path.join(BACKUP_DIR, `${path.basename(path.dirname(dir))}-${path.basename(dir)}-${stamp}.tar`.replace(/^\./, ""));
            execFileSync("tar", ["-cf", tar, "-C", path.dirname(dir), path.basename(dir)]);
            stats.backups.push(tar);
        }
        for (const name of fs.readdirSync(dir)) {
            const p = path.join(dir, name);
            if (name.startsWith(".") || keepSet.has(name) || isPluginFolder(p)) {
                stats.kept++;
                continue;
            }
            const dest = path.join(LIBRARY_DIR, name);
            const lst = fs.lstatSync(p);
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
                        fs.symlinkSync(target, dest);
                    taken.set(name, target);
                    stats.linked++;
                }
                else if (taken.get(name) !== target) {
                    const alt = path.join(LIBRARY_DIR, ".conflicts", path.basename(path.dirname(dir)), name);
                    if (apply) {
                        fs.mkdirSync(path.dirname(alt), { recursive: true });
                        if (!fs.existsSync(alt))
                            fs.symlinkSync(target, alt);
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
                    fs.renameSync(p, to);
                }
            }
            else {
                stats.kept++;
            }
        }
    }
    if (apply) {
        const restore = stats.backups.map((t) => `tar -xf ${t} -C ${path.dirname(path.dirname(t))}  # rm -rf the folder first`).join("\n");
        fs.writeFileSync(path.join(BACKUP_DIR, `RESTORE-${stamp}.md`), `# Undo trim ${stamp}\n\nRemove the agent folder, then:\n\n\`\`\`bash\n${restore}\n\`\`\`\n`);
    }
    return stats;
}
