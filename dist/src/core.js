import fs from "node:fs";
import path from "node:path";
import { CORE_DIR, CORE_FILE, SR_DIR, AGENT_SKILL_DIRS } from "./paths.js";
import { findSkill, getIndex } from "./search.js";
/** core.txt: one skill id per line, '#' comments. These are the only skills agents preload. */
export function readCore() {
    try {
        return fs.readFileSync(CORE_FILE, "utf8").split(/\r?\n/).map((l) => l.split("#")[0].trim()).filter(Boolean);
    }
    catch {
        return [];
    }
}
export function writeCore(ids) {
    fs.mkdirSync(SR_DIR, { recursive: true });
    fs.writeFileSync(CORE_FILE, "# skillrouter core: skills every agent preloads. Everything else is reachable via search_skills/read_skill.\n" + [...new Set(ids)].join("\n") + "\n");
}
/** Rebuild ~/.skillrouter/core as symlinks to the core skills, then link them into the agent folders that need them. */
export function syncCore(agents) {
    const ids = readCore();
    fs.rmSync(CORE_DIR, { recursive: true, force: true });
    fs.mkdirSync(CORE_DIR, { recursive: true });
    const missing = [];
    let linked = 0;
    const targets = new Map();
    for (const id of ids) {
        const m = findSkill(id);
        if (m.length !== 1) {
            missing.push(id);
            continue;
        }
        targets.set(path.basename(m[0].path).replace(/~\d+$/, ""), m[0].path);
    }
    for (const [name, target] of targets) {
        fs.symlinkSync(target, path.join(CORE_DIR, name));
        linked++;
    }
    // Each agent gets core in its first folder; a folder shared across agents (~/.agents/skills) is linked once.
    const done = new Set();
    for (const agent of agents) {
        const dir = AGENT_SKILL_DIRS[agent][0];
        if (done.has(dir))
            continue;
        done.add(dir);
        fs.mkdirSync(dir, { recursive: true });
        for (const [name, target] of targets) {
            const link = path.join(dir, name);
            if (fs.existsSync(link))
                continue; // real folder or existing link: leave it
            try {
                fs.unlinkSync(link);
            }
            catch { /* not a dangling link */ }
            fs.symlinkSync(target, link);
        }
    }
    return { linked, missing };
}
/** Starting point: the N skills with the most reads in the usage log, or (first run) nothing. */
export function suggestCore(reads, n = 30) {
    const { index } = getIndex();
    const known = new Set(index.skills.map((s) => s.id));
    return [...reads.entries()].filter(([id]) => known.has(id)).sort((a, b) => b[1] - a[1]).slice(0, n).map(([id]) => id);
}
