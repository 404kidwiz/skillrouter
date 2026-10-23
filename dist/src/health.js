import fs from "node:fs";
import path from "node:path";
import { HOME, AGENTS } from "./paths.js";
import { loadIndex } from "./index.js";
import { isRouterHook } from "./install.js";
import { readLog } from "./report.js";
import { hermesSpec } from "./live.js";
import { loadVectors, vectorsExist } from "./embed.js";
function json(file) {
    try {
        return { data: JSON.parse(fs.readFileSync(file, "utf8")), status: "missing" };
    }
    catch {
        return { status: fs.existsSync(file) ? "invalid config" : "missing" };
    }
}
export function configuration(agent, home = HOME) {
    const file = (...parts) => path.join(home, ...parts);
    const hookFile = agent === "claude" ? file(".claude", "settings.json") : agent === "gemini" ? file(".gemini", "settings.json") : file(`.${agent}`, "hooks.json");
    const hooks = json(hookFile);
    const event = agent === "cursor" ? "beforeSubmitPrompt" : agent === "gemini" ? "BeforeAgent" : "UserPromptSubmit";
    const entries = hooks.data?.hooks?.[event];
    let hook = Array.isArray(entries) && entries.some(isRouterHook) ? "configured (activation unverified)" : hooks.status;
    let mcpFile = agent === "claude" ? file(".claude.json") : agent === "gemini" ? hookFile : file(`.${agent}`, "mcp.json");
    if (agent === "codex") {
        try {
            const config = fs.readFileSync(file(".codex", "config.toml"), "utf8");
            const section = config.match(/^\[mcp_servers\.skillrouter\]\s*\n([^]*?)(?=^\[|$(?![^]))/m)?.[1];
            return { hook, mcp: section && /^command\s*=\s*["']/m.test(section)
                    ? /^enabled\s*=\s*false/m.test(section) ? "disabled" : "configured (connection unverified)" : "missing" };
        }
        catch {
            return { hook, mcp: "missing/unreadable" };
        }
    }
    if (agent === "opencode") {
        mcpFile = file(".config", "opencode", "opencode.json");
        const plugin = file(".config", "opencode", "plugins", "skillrouter-hints.js");
        hook = fs.existsSync(plugin) ? "plugin present (activation unverified)" : "missing";
    }
    const config = json(mcpFile);
    const entry = agent === "opencode" ? config.data?.mcp?.skillrouter : config.data?.mcpServers?.skillrouter;
    return { hook, mcp: entry?.enabled === false || entry?.disabled === true ? "disabled" :
            entry && (typeof entry.command === "string" || Array.isArray(entry.command)) ? "configured (connection unverified)" : config.status };
}
/** MCP-only hosts: configured or not, from the same files `doctor --live` would launch. */
export function mcpOnlyConfiguration(target, home = HOME) {
    const file = (...p) => path.join(home, ...p);
    if (target === "hermes") {
        try {
            return hermesSpec(fs.readFileSync(file(".hermes", "config.yaml"), "utf8")) ? "configured (connection unverified)" : "missing";
        }
        catch {
            return "missing";
        }
    }
    const cfg = json(target === "openclaude" ? file(".openclaude.json") : file(".gemini", "antigravity", "mcp_config.json"));
    const entry = cfg.data?.mcpServers?.skillrouter;
    return entry?.disabled === true ? "disabled" : entry && typeof entry.command === "string" ? "configured (connection unverified)" : cfg.status;
}
export function health(home = HOME) {
    const loaded = loadIndex();
    const index = loaded && Array.isArray(loaded.skills) ? loaded : null;
    const age = index ? (Date.now() - Date.parse(index.builtAt)) / 3600000 : NaN;
    const vec = loadVectors();
    const vectors = !vec ? (vectorsExist() ? "unreadable (run: skillrouter index --embeddings)" : "off (BM25 only; see README to enable)")
        : index && vec.indexBuiltAt !== index.builtAt ? "STALE: built for another index, hints use BM25 (run: skillrouter index --embeddings)"
            : `${vec.ids.length} skills`;
    const out = ["", `Index: ${!index ? "missing or invalid" : !Number.isFinite(age) ? "invalid timestamp" : `${index.skills.length} skills; ${Math.max(0, age).toFixed(1)} hours old${age > 168 ? " (stale: over 7 days)" : ""}`}`,
        `Vectors: ${vectors}`,
        "Per-agent health (observations from last 7 days):"];
    const rows = readLog(7);
    // Claude Code also runs the PostToolUse trigger hook and the Stop decision hook.
    let claudeExtra = "";
    try {
        const d = JSON.parse(fs.readFileSync(path.join(home, ".claude", "settings.json"), "utf8"));
        const has = (ev) => Array.isArray(d?.hooks?.[ev]) && d.hooks[ev].some(isRouterHook);
        claudeExtra = `; triggers ${has("PostToolUse") ? "configured" : "missing"}; decision nudge ${has("Stop") ? "configured" : "missing"}`;
    }
    catch { /* reported by configuration() */ }
    for (const agent of AGENTS) {
        const config = configuration(agent, home);
        const own = rows.filter((r) => r.agent === agent || r.client === `hook/${agent}`);
        const hooks = own.filter((r) => r.tool === "hint").sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
        const mcp = own.filter((r) => r.tool === "search_skills" || r.tool === "read_skill").sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
        const failures = own.filter((r) => (r.tool === "read_skill" && r.found === false) ||
            ["timeout", "input_timeout", "input_too_large", "invalid_input", "execution_error", "index_error", "missing_index"].includes(r.reason ?? "")).length;
        const reasons = new Map();
        for (const row of hooks)
            reasons.set(row.reason ?? "legacy/unknown", (reasons.get(row.reason ?? "legacy/unknown") ?? 0) + 1);
        out.push(`  ${agent}: hook ${config.hook}; MCP ${config.mcp}${agent === "claude" ? claudeExtra : ""}`, `    last hook: ${hooks[0]?.ts ?? "not observed"}; last MCP activity: ${mcp[0]?.ts ?? "not observed"}; failures: ${failures}`, `    hook outcomes: ${[...reasons].map(([reason, n]) => `${reason}=${n}`).join(", ") || "none observed"}`);
    }
    for (const target of ["openclaude", "antigravity", "hermes"]) {
        const own = rows.filter((r) => r.agent === target);
        const last = own.filter((r) => r.tool === "search_skills" || r.tool === "read_skill").sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts))[0]?.ts;
        out.push(`  ${target}: no hooks on this host; MCP ${mcpOnlyConfiguration(target, home)}`, `    last MCP activity: ${last ?? "not observed"}`);
    }
    out.push("Configuration presence does not prove hook trust/activation or MCP connectivity (run `doctor --live` to start each server). Plugin/project configs and legacy MCP clients without agent identity may be unobserved.");
    return out;
}
