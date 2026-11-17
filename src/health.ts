import fs from "node:fs";
import path from "node:path";
import { HOME, AGENTS, antigravityConfigPaths, type AgentId } from "./paths.js";
import { loadIndex } from "./index.js";
import { isRouterHook } from "./pins.js";
import { readLog, agentOf, isSynthetic } from "./report.js";
import { gateFunnel } from "./funnel.js";
import { hermesSpec } from "./live.js";
import { loadVectors, vectorsBuiltWith, vectorsExist } from "./embed.js";
import { serviceEnabled, serviceSnapshot, stateDirPrivate } from "./service-client.js";
import { parseJson } from "./platform.js";

function json(file: string): { data?: any; status: string } {
  try { return { data: parseJson(fs.readFileSync(file, "utf8")), status: "missing" }; }
  catch { return { status: fs.existsSync(file) ? "invalid config" : "missing" }; }
}

export function configuration(agent: AgentId, home = HOME): { hook: string; mcp: string } {
  const file = (...parts: string[]) => path.join(home, ...parts);
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
    } catch { return { hook, mcp: "missing/unreadable" }; }
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
export function mcpOnlyConfiguration(target: "openclaude" | "antigravity" | "hermes", home = HOME): string {
  const file = (...p: string[]) => path.join(home, ...p);
  if (target === "hermes") {
    try { return hermesSpec(fs.readFileSync(file(".hermes", "config.yaml"), "utf8")) ? "configured (connection unverified)" : "missing"; }
    catch { return "missing"; }
  }
  const cfg = json(target === "openclaude" ? file(".openclaude.json") : antigravityConfigPaths(home).current);
  const entry = cfg.data?.mcpServers?.skillrouter;
  return entry?.disabled === true || (target === "antigravity" && entry?.enabled === false) ? "disabled" : entry && typeof entry.command === "string" ? "configured (connection unverified)" : cfg.status;
}

/** Hermes and Antigravity: whether the router's hooks are in the host's config, and (Hermes) approved there. */
export function hostHooks(target: "hermes" | "antigravity", home = HOME): string {
  const file = (...p: string[]) => path.join(home, ...p);
  if (target === "antigravity") {
    const group = json(file(".gemini", "config", "hooks.json")).data?.skillrouter;
    if (!group || typeof group !== "object") return "not installed (experimental: `skillrouter install antigravity --hooks`)";
    return group.enabled === false ? "installed but switched off (\"enabled\": false)" : "configured: prompt check + search gate (experimental; activation unverified)";
  }
  let text: string;
  try { text = fs.readFileSync(file(".hermes", "config.yaml"), "utf8"); } catch { return "missing"; }
  // As written in the file: a quote after the launcher path may be escaped (a double-quoted YAML or JSON string on Windows).
  const ours = /skillrouter-hint(?:\.mjs)?\\?['"]?\s+hermes\b/;
  if (!ours.test(text)) return "not installed (run `skillrouter install hermes`)";
  let approved = false;
  try { const a = JSON.parse(fs.readFileSync(file(".hermes", "shell-hooks-allowlist.json"), "utf8"))?.approvals; approved = Array.isArray(a) && a.some((e) => typeof e?.command === "string" && ours.test(e.command)); } catch { /* no allowlist yet */ }
  return `configured: prompt check + search gate; ${approved ? "approved in Hermes" : "NOT yet approved in Hermes, so they do not run (accept them in `hermes chat`, or `skillrouter install hermes --accept-hooks`)"}`;
}

/** Where each host keeps its after-tool (trigger), end-of-turn (decision nudge) and before-tool (search gate) hooks. OpenCode has triggers only. */
const ACTION_HOOKS: Record<AgentId, { file: string[]; tool: string; stop?: string; gate?: string }> = {
  claude: { file: [".claude", "settings.json"], tool: "PostToolUse", stop: "Stop", gate: "PreToolUse" },
  codex: { file: [".codex", "hooks.json"], tool: "PostToolUse", stop: "Stop", gate: "PreToolUse" },
  cursor: { file: [".cursor", "hooks.json"], tool: "postToolUse", stop: "stop", gate: "preToolUse" },
  gemini: { file: [".gemini", "settings.json"], tool: "AfterTool", stop: "AfterAgent", gate: "BeforeTool" },
  opencode: { file: [".config", "opencode", "plugins", "skillrouter-hints.js"], tool: "tool.execute.after" },
};

function actionHooks(agent: AgentId, home: string): string {
  const spec = ACTION_HOOKS[agent];
  const file = path.join(home, ...spec.file);
  try {
    if (agent === "opencode") return `; triggers ${fs.readFileSync(file, "utf8").includes(spec.tool) ? "configured" : "missing (rerun install opencode)"}; no decision nudge on this host`;
    const d = parseJson(fs.readFileSync(file, "utf8"));
    const has = (ev: string) => Array.isArray(d?.hooks?.[ev]) && d.hooks[ev].some(isRouterHook);
    return `; triggers ${has(spec.tool) ? "configured" : "missing"}; decision nudge ${has(spec.stop!) ? "configured" : "missing"}; search gate ${has(spec.gate!) ? "configured" : "missing"}`;
  } catch { return ""; } // reported by configuration()
}

/**
 * What the semantic layer did in real prompt checks: vectors on disk mean nothing if every hook fell back to BM25.
 * (On this machine, 2026-10-24, 80 of 142 hints ran with the layer in error for a day before anyone noticed.)
 */
export function semanticLine(rows: { tool?: unknown; reason?: unknown; sem?: unknown; sem_error?: unknown }[]): string {
  const checks = rows.filter((r) => r.tool === "hint" && (r.reason === "shown" || r.reason === "no_match"));
  if (!checks.length) return "Semantic layer in prompt checks (7 days): no prompt checks recorded";
  const by = new Map<string, number>();
  for (const r of checks) { const k = typeof r.sem === "string" ? r.sem : "off"; by.set(k, (by.get(k) ?? 0) + 1); }
  const parts = [...by.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(", ");
  const lastError = [...checks].reverse().find((r) => typeof r.sem_error === "string")?.sem_error;
  const bad = (by.get("error") ?? 0) + (by.get("timeout") ?? 0) + (by.get("stale") ?? 0);
  const verdict = bad > checks.length / 2 ? " — most checks fell back to BM25 alone; hints were far less precise" : "";
  return `Semantic layer in prompt checks (7 days): ${parts}${verdict}${lastError ? `; last error: ${lastError}` : ""}`;
}

/** The warm service: running (pid, uptime, requests), not running (starts on the first hook), or switched off. */
function serviceLine(): string {
  if (process.env.SKILLROUTER_SERVICE === "0") return "off (SKILLROUTER_SERVICE=0); hooks run on their own";
  if (!serviceEnabled() && !stateDirPrivate()) return "off on Windows: the state folder is outside your profile, where other users could read the service's key; hooks run on their own";
  const s = serviceSnapshot();
  if (!s.running) return "not running (starts itself on the next hook; `skillrouter service start` to start it now)";
  const up = s.startedAt ? `, up ${Math.max(0, Math.round((Date.now() - Date.parse(s.startedAt)) / 60000))} min` : "";
  return `running (pid ${s.pid}${up}${s.requests !== undefined ? `, ${s.requests} requests` : ""}${s.rssMB ? `, ${s.rssMB} MB` : ""})`;
}

// Gemini CLI can be silent for a reason no prompt will fix. Seen on two Macs, 2026-11-16: Google answers a personal
// Google sign-in with UNSUPPORTED_CLIENT ("no longer supported for Gemini Code Assist for individuals"), so the CLI stops
// before any hook runs. Doctor cannot see the account from here, so it names the case instead of only saying "send one prompt".
const GEMINI_CLI_SIGN_IN = " If Gemini CLI itself stops with UNSUPPORTED_CLIENT, Google no longer accepts its personal-account sign-in: it runs only with an API key, Vertex AI or a Workspace account, and silence here is then expected.";

export function health(home = HOME): string[] {
  const loaded = loadIndex();
  const index = loaded && Array.isArray(loaded.skills) ? loaded : null;
  const age = index ? (Date.now() - Date.parse(index.builtAt)) / 3600000 : NaN;
  const vec = loadVectors();
  const oldModel = vec ? undefined : vectorsBuiltWith();
  const vectors = !vec ? (oldModel ? `built with another model (${oldModel}); hints use BM25 until rebuilt (run: skillrouter index --embeddings)`
      : vectorsExist() ? "unreadable (run: skillrouter index --embeddings)" : "off (BM25 only; see README to enable)")
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
    const reasons = new Map<string, number>();
    for (const row of hooks) reasons.set(row.reason ?? "legacy/unknown", (reasons.get(row.reason ?? "legacy/unknown") ?? 0) + 1);
    const count = (tool: string, reason: string) => own.filter((r) => r.tool === tool && r.reason === reason).length;
    // Configured but silent: either the host was not used, or its hooks stopped firing. Only a prompt there tells which.
    // Tool hooks ran but the prompt hook never did (gate.ts logs one "no_prompt_event" row per such session): the hooks
    // are firing, yet with no prompt to check, the prompt check does nothing there and the search gate cannot tell a task
    // turn (on Cursor it asks once per session instead, see gate.ts). Saying "not firing" would send the user after the wrong problem.
    const toolOnly = own.filter((r) => r.tool === "gate" && r.reason === "no_prompt_event").sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
    const quiet = !/^(configured|plugin present)/.test(config.hook) || hooks.length ? ""
      : toolOnly.length
        ? `\n    NOTE: tool hooks ran (last ${toolOnly[0].ts}, ${toolOnly.length} session${toolOnly.length === 1 ? "" : "s"}) but no prompt event arrived in 7 days, so ${agent === "cursor" ? "the prompt check did nothing there and the search gate asked once per session instead of once per task. Cursor's CLI (cursor-agent) does not send beforeSubmitPrompt; its editor does." : "the prompt check and search gate did nothing there. Check that the host trusts the prompt hook."}`
        : `\n    NOTE: hooks are configured but none ran in 7 days. If you used ${agent} this week its hooks are not firing: send one prompt there, then rerun doctor.${agent === "gemini" ? GEMINI_CLI_SIGN_IN : ""}`;
    out.push(`  ${agent}: hook ${config.hook}; MCP ${config.mcp}${extra}${quiet}`,
      `    last hook: ${hooks[0]?.ts ?? "not observed"}; last MCP activity: ${mcp[0]?.ts ?? "not observed"}; failures: ${failures}`,
      `    hook outcomes: ${[...reasons].map(([reason, n]) => `${reason}=${n}`).join(", ") || "none observed"}`,
      `    triggers shown: ${count("trigger", "shown")}; turns decided: ${count("decision", "decided")}; nudged: ${count("decision", "nudged")}`);
  }
  for (const target of ["openclaude", "antigravity", "hermes"] as const) {
    const own = rows.filter((r) => r.agent === target);
    const last = own.filter((r) => r.tool === "search_skills" || r.tool === "read_skill").sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts))[0]?.ts;
    if (target === "openclaude") { out.push(`  ${target}: no hooks on this host; MCP ${mcpOnlyConfiguration(target, home)}`, `    last MCP activity: ${last ?? "not observed"}`); continue; }
    const hooks = rows.filter((r) => r.client === `hook/${target}` && r.tool === "hint").sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
    const denied = rows.filter((r) => r.client === `hook/${target}` && r.tool === "gate" && r.reason === "denied").length;
    out.push(`  ${target}: hooks ${hostHooks(target, home)}; MCP ${mcpOnlyConfiguration(target, home)}`,
      `    last hook: ${hooks[0]?.ts ?? "not observed"}; last MCP activity: ${last ?? "not observed"}; gate refusals: ${denied}`);
  }
  // A turn that stopped at the gate is lost work the user never sees (2026-11-11: an hourly job did, 88 times in 4 days).
  try {
    const day = Date.now() - 86400e3;
    const stalled = gateFunnel(rows.filter((r) => Date.parse(r.ts) >= day && !isSynthetic(r)), agentOf, day).filter((l) => l.stalled);
    if (stalled.length) out.push(`WARNING: in the last 24 hours ${stalled.map((l) => `${l.agent} ${l.stalled}`).join(", ")} task turn(s) stopped after a search-gate refusal, with no search and no further work. ` +
      "A recurring request that does this twice is let through from then on; `skillrouter report 1` shows the gate per agent.");
  } catch { /* session state unreadable: the rest of doctor still reports */ }
  out.push("Configuration presence does not prove hook trust/activation or MCP connectivity (run `doctor --live` to start each server). Plugin/project configs and legacy MCP clients without agent identity may be unobserved.");
  return out;
}
