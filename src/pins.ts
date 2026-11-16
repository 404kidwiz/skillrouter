import fs from "node:fs";
import path from "node:path";
import { SR_DIR, AGENTS, type AgentId } from "./paths.js";

// What install, doctor and report all need to know about hosts and pins, kept apart from install.ts: importing
// that module resolves the Node to pin, which can run other `node` binaries and has no place in a report.

/** Agents that get the MCP server but have no prompt hook of their own. */
export const MCP_ONLY = ["openclaude", "antigravity", "hermes"] as const;
export type McpOnlyId = (typeof MCP_ONLY)[number];
export type InstallTarget = AgentId | McpOnlyId;
export const INSTALL_TARGETS: InstallTarget[] = [...AGENTS, ...MCP_ONLY];

/**
 * Hooks call a launcher whose path never changes, so a hook's command text (what Codex hashes
 * for trust, what Cursor and Gemini store) survives upgrades and Node changes: `install` only
 * rewrites what the launcher execs.
 */
export const LAUNCHER = path.join(SR_DIR, "bin", "skillrouter-hint");

/** Folders a tool manages for itself: a Node under one can vanish or change with that tool. Either separator, on every OS. */
const MANAGED = /[\\/](?:\.hermes|node_modules|vite-plus|\.nvm|\.fnm|\.volta|\.asdf|\.nodenv|\.nodebrew|\.n|\.mise|nix[\\/]store)[\\/]/;
export const managedNode = (p: string): boolean => MANAGED.test(p);
/**
 * A Node path that will not survive an update: under a managed tree, or below a folder whose name carries a version
 * number (`…/js_runtime/node/26.13.1/bin/node`, `…/nvm/v22.4.0/…`, `…/Cellar/node@22/22.1.0_1/…`,
 * `/opt/node-v22.4.0-linux-x64/…`, mise's `…/node/22.4/…`). On 2026-11-15 every hook and Codex's MCP server on the
 * author's Mac were pinned to such a folder, one cleanup away from failing all at once. A folder that merely looks
 * like a version (`/home/1.2.3/…`) is also judged volatile: the cost is only that another Node is preferred.
 */
export function volatileNode(p: string): boolean {
  return managedNode(p) || /(?:^|[\\/])[^\\/]*\d+\.\d+[^\\/]*[\\/]/.test(p);
}
/** Stable homes of Node, tried after PATH. */
export const NODE_FALLBACKS = ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"];

export function isRouterHook(entry: unknown): boolean {
  if (!entry || typeof entry !== "object") return false;
  const value = entry as { command?: unknown; hooks?: unknown[] };
  return (typeof value.command === "string" && /(?:skillrouter-hint(?:\.mjs)?['"]?|skillrouter|cli\.js['"]?|skill_hint_hook\.py['"]?)\s+(?:hint\s+)?(?:claude|codex|cursor|gemini|opencode)\b/.test(value.command)) ||
    (Array.isArray(value.hooks) && value.hooks.some(isRouterHook));
}

/** What `doctor` says about the pins: each configured Node and CLI path must exist, and a Node path should be stable. */
export function pinProblems(specs: { host: string; command: unknown; args: unknown }[], launcher = LAUNCHER): string[] {
  const out: string[] = [];
  const check = (host: string, node: string | undefined, cli: string | undefined) => {
    if (node && !path.isAbsolute(node) && /[\\/]/.test(node)) out.push(`${host}: Node path ${node} is relative; it only works from one folder. Run \`skillrouter install\``);
    else if (node && path.isAbsolute(node) && !fs.existsSync(node)) out.push(`${host}: Node ${node} is missing; run \`skillrouter install\``);
    else if (node && volatileNode(node)) out.push(`${host}: Node ${node} sits in a versioned or managed folder and can vanish on an update; run \`skillrouter install\` (or set SKILLROUTER_NODE)`);
    if (cli && !path.isAbsolute(cli)) out.push(`${host}: code path ${cli} is relative; it only works from one folder. Run \`skillrouter install\``);
    else if (cli && path.isAbsolute(cli) && !fs.existsSync(cli)) out.push(`${host}: code ${cli} is missing; run \`skillrouter install\``);
    else if (cli) { const mods = path.resolve(path.dirname(cli), "..", "..", "node_modules"); try { fs.lstatSync(mods); if (!fs.existsSync(mods)) out.push(`${host}: dependencies of ${cli} are gone (${mods} points nowhere); run \`skillrouter install\` from the checkout`); } catch { /* an installed package keeps them elsewhere */ } }
  };
  for (const s of specs) check(s.host, typeof s.command === "string" ? s.command : undefined, (Array.isArray(s.args) ? s.args : []).find((a): a is string => typeof a === "string" && /cli\.js$/.test(a)));
  try {
    const text = fs.readFileSync(launcher, "utf8");
    check("hooks (launcher)", text.match(/^NODE='([^']+)'/m)?.[1] ?? text.match(/^exec '([^']+)'/m)?.[1], text.match(/'([^']*cli\.js)' hint/)?.[1]);
  } catch { /* no launcher: no hooks installed, or Windows */ }
  return out;
}
