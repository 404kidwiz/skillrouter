import fs from "node:fs";
import path from "node:path";
import { HOME, AGENTS, antigravityConfigPaths } from "./paths.js";
import { loadIndex } from "./index.js";
import { isRouterHook } from "./install.js";
import { readLog } from "./report.js";
import { hermesSpec } from "./live.js";
import { loadVectors, vectorsExist } from "./embed.js";
import { serviceEnabled, serviceSnapshot, stateDirPrivate } from "./service-client.js";
import { parseJson } from "./platform.js";
function json(file) {
    try {
        return { data: parseJson(fs.readFileSync(file, "utf8")), status: "missing" };
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
    const cfg = json(target === "openclaude" ? file(".openclaude.json") : antigravityConfigPaths(home).current);
    const entry = cfg.data?.mcpServers?.skillrouter;
    return entry?.disabled === true || (target === "antigravity" && entry?.enabled === false) ? "disabled" : entry && typeof entry.command === "string" ? "configured (connection unverified)" : cfg.status;
}
/** Where each host keeps its after-tool (trigger), end-of-turn (decision nudge) and before-tool (search gate) hooks. OpenCode has triggers only. */
const ACTION_HOOKS = {
    claude: { file: [".claude", "settings.json"], tool: "PostToolUse", stop: "Stop", gate: "PreToolUse" },
    codex: { file: [".codex", "hooks.json"], tool: "PostToolUse", stop: "Stop", gate: "PreToolUse" },
    cursor: { file: [".cursor", "hooks.json"], tool: "postToolUse", stop: "stop", gate: "preToolUse" },
    gemini: { file: [".gemini", "settings.json"], tool: "AfterTool", stop: "AfterAgent", gate: "BeforeTool" },
    opencode: { file: [".config", "opencode", "plugins", "skillrouter-hints.js"], tool: "tool.execute.after" },
};
function actionHooks(agent, home) {
    const spec = ACTION_HOOKS[agent];
    const file = path.join(home, ...spec.file);
    try {
        if (agent === "opencode")
            return `; triggers ${fs.readFileSync(file, "utf8").includes(spec.tool) ? "configured" : "missing (rerun install opencode)"}; no decision nudge on this host`;
        const d = parseJson(fs.readFileSync(file, "utf8"));
        const has = (ev) => Array.isArray(d?.hooks?.[ev]) && d.hooks[ev].some(isRouterHook);
        return `; triggers ${has(spec.tool) ? "configured" : "missing"}; decision nudge ${has(spec.stop) ? "configured" : "missing"}; search gate ${has(spec.gate) ? "configured" : "missing"}`;
    }
    catch {
        return "";
    } // reported by configuration()
}
/**
 * What the semantic layer did in real prompt checks: vectors on disk mean nothing if every hook fell back to BM25.
 * (On this machine, 2026-10-24, 80 of 142 hints ran with the layer in error for a day before anyone noticed.)
 */
export function semanticLine(rows) {
    const checks = rows.filter((r) => r.tool === "hint" && (r.reason === "shown" || r.reason === "no_match"));
    if (!checks.length)
        return "Semantic layer in prompt checks (7 days): no prompt checks recorded";
    const by = new Map();
    for (const r of checks) {
        const k = typeof r.sem === "string" ? r.sem : "off";
        by.set(k, (by.get(k) ?? 0) + 1);
    }
    const parts = [...by.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(", ");
    const lastError = [...checks].reverse().find((r) => typeof r.sem_error === "string")?.sem_error;
    const bad = (by.get("error") ?? 0) + (by.get("timeout") ?? 0) + (by.get("stale") ?? 0);
    const verdict = bad > checks.length / 2 ? " — most checks fell back to BM25 alone; hints were far less precise" : "";
    return `Semantic layer in prompt checks (7 days): ${parts}${verdict}${lastError ? `; last error: ${lastError}` : ""}`;
}
/** The warm service: running (pid, uptime, requests), not running (starts on the first hook), or switched off. */
function serviceLine() {
    if (process.env.SKILLROUTER_SERVICE === "0")
        return "off (SKILLROUTER_SERVICE=0); hooks run on their own";
    if (!serviceEnabled() && !stateDirPrivate())
        return "off on Windows: the state folder is outside your profile, where other users could read the service's key; hooks run on their own";
    const s = serviceSnapshot();
    if (!s.running)
        return "not running (starts itself on the next hook; `skillrouter service start` to start it now)";
    const up = s.startedAt ? `, up ${Math.max(0, Math.round((Date.now() - Date.parse(s.startedAt)) / 60000))} min` : "";
    return `running (pid ${s.pid}${up}${s.requests !== undefined ? `, ${s.requests} requests` : ""}${s.rssMB ? `, ${s.rssMB} MB` : ""})`;
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
        `Service: ${serviceLine()}`];
    const rows = readLog(7);
    out.push(semanticLine(rows), "Per-agent health (observations from last 7 days):");
    for (const agent of AGENTS) {
        const extra = actionHooks(agent, home);
        const config = configuration(agent, home);
        const own = rows.filter((r) => r.agent === agent || r.client === `hook/${agent}`);
        const hooks = own.filter((r) => r.tool === "hint").sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
        const mcp = own.filter((r) => r.tool === "search_skills" || r.tool === "read_skill").sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
        const failures = own.filter((r) => (r.tool === "read_skill" && r.found === false) ||
            ["timeout", "input_timeout", "input_too_large", "invalid_input", "execution_error", "index_error", "missing_index"].includes(r.reason ?? "")).length;
        const reasons = new Map();
        for (const row of hooks)
            reasons.set(row.reason ?? "legacy/unknown", (reasons.get(row.reason ?? "legacy/unknown") ?? 0) + 1);
        const count = (tool, reason) => own.filter((r) => r.tool === tool && r.reason === reason).length;
        out.push(`  ${agent}: hook ${config.hook}; MCP ${config.mcp}${extra}`, `    last hook: ${hooks[0]?.ts ?? "not observed"}; last MCP activity: ${mcp[0]?.ts ?? "not observed"}; failures: ${failures}`, `    hook outcomes: ${[...reasons].map(([reason, n]) => `${reason}=${n}`).join(", ") || "none observed"}`, `    triggers shown: ${count("trigger", "shown")}; turns decided: ${count("decision", "decided")}; nudged: ${count("decision", "nudged")}`);
    }
    for (const target of ["openclaude", "antigravity", "hermes"]) {
        const own = rows.filter((r) => r.agent === target);
        const last = own.filter((r) => r.tool === "search_skills" || r.tool === "read_skill").sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts))[0]?.ts;
        out.push(`  ${target}: no hooks on this host; MCP ${mcpOnlyConfiguration(target, home)}`, `    last MCP activity: ${last ?? "not observed"}`);
    }
    out.push("Configuration presence does not prove hook trust/activation or MCP connectivity (run `doctor --live` to start each server). Plugin/project configs and legacy MCP clients without agent identity may be unobserved.");
    return out;
}
