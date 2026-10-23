import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { HOME, SR_DIR, AGENTS, type AgentId } from "./paths.js";

// Pin both integrations to this installed package; prompt submission never invokes npm.
import { fileURLToPath } from "node:url";
const CLI = fileURLToPath(new URL("./cli.js", import.meta.url));

/** Agents that get the MCP server but have no prompt hook of their own. */
export const MCP_ONLY = ["openclaude", "antigravity", "hermes"] as const;
export type McpOnlyId = (typeof MCP_ONLY)[number];
export type InstallTarget = AgentId | McpOnlyId;
export const INSTALL_TARGETS: InstallTarget[] = [...AGENTS, ...MCP_ONLY];

/** A Node binary another tool does not manage: the one running us, unless it lives under a managed
 * tree (~/.hermes, node_modules, …), then the first `node` on PATH that doesn't. SKILLROUTER_NODE overrides. */
export function resolveNode(): string {
  if (process.env.SKILLROUTER_NODE) return process.env.SKILLROUTER_NODE;
  const managed = (p: string) => [`${path.sep}.hermes${path.sep}`, `${path.sep}node_modules${path.sep}`].some((m) => p.includes(m));
  const real = (p: string) => { try { return fs.realpathSync(p); } catch { return p; } };
  if (!managed(real(process.execPath))) return process.execPath;
  for (const dir of (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    const cand = path.join(dir, "node");
    try { if (fs.statSync(cand).isFile() && !managed(real(cand))) return cand; } catch { /* not here */ }
  }
  return process.execPath;
}

export const NODE = resolveNode();
const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
/**
 * Hooks call a launcher whose path never changes, so a hook's command text (what Codex hashes
 * for trust, what Cursor and Gemini store) survives upgrades and Node changes: `install` only
 * rewrites what the launcher execs.
 */
export const LAUNCHER = path.join(SR_DIR, "bin", "skillrouter-hint");
const BIN = quote(LAUNCHER);
const MCP_CMD = { command: NODE, args: [CLI, "mcp"] };
const TOML_MCP = `command = ${JSON.stringify(NODE)}\nargs = [${JSON.stringify(CLI)}, "mcp"]`;

export function writeLauncher(node = NODE, cli = CLI, launcher = LAUNCHER): string {
  fs.mkdirSync(path.dirname(launcher), { recursive: true });
  const body = `#!/bin/sh\n# skillrouter prompt-hook launcher. Rewritten by \`skillrouter install\`; hook configs point here so their text never changes.\nexec ${quote(node)} ${quote(cli)} hint "$@"\n`;
  fs.writeFileSync(launcher + ".tmp", body, { mode: 0o755 });
  fs.renameSync(launcher + ".tmp", launcher);
  fs.chmodSync(launcher, 0o755);
  return `${launcher}: execs ${node} ${cli}`;
}

export function isRouterHook(entry: unknown): boolean {
  if (!entry || typeof entry !== "object") return false;
  const value = entry as { command?: unknown; hooks?: unknown[] };
  return (typeof value.command === "string" && /(?:skillrouter-hint['"]?|skillrouter|cli\.js['"]?|skill_hint_hook\.py['"]?)\s+(?:hint\s+)?(?:claude|codex|cursor|gemini|opencode)\b/.test(value.command)) ||
    (Array.isArray(value.hooks) && value.hooks.some(isRouterHook));
}

function patchJson(file: string, fn: (d: any) => string, create: object = {}): string {
  let d: any = create;
  let mode: number | undefined;
  if (fs.existsSync(file)) {
    mode = fs.statSync(file).mode & 0o777; // a config holding keys (0600) keeps its permissions
    backup(file, mode);
    d = JSON.parse(fs.readFileSync(file, "utf8"));
  } else fs.mkdirSync(path.dirname(file), { recursive: true });
  const msg = fn(d);
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(d, null, 2) + "\n", mode !== undefined ? { mode } : {});
  JSON.parse(fs.readFileSync(tmp, "utf8"));
  if (mode !== undefined) fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, file);
  return `${file}: ${msg}`;
}

export function addHook(d: any, event: string, entry: object): string {
  const list = ((d.hooks ??= {})[event] ??= []) as object[];
  // Replace only router commands, preserving unrelated commands grouped in the same entry.
  for (let i = list.length - 1; i >= 0; i--) {
    const item = list[i] as { hooks?: unknown[] };
    if (!isRouterHook(item)) continue;
    if (Array.isArray(item.hooks)) {
      item.hooks = item.hooks.filter((h) => !isRouterHook(h));
      if (item.hooks.length) continue;
    }
    list.splice(i, 1);
  }
  list.push(entry);
  return `added ${event} hook`;
}

// The router's read_skill is mcp__skillrouter__read_skill when installed here and mcp__plugin_…skillrouter__read_skill from the plugin.
export const CLAUDE_TOOL_MATCHER = "Edit|Write|MultiEdit|NotebookEdit|Bash|Skill|mcp__.*skillrouter__read_skill";

const mcpEntry = (agent: string, prev: any = {}) => ({ ...prev, ...MCP_CMD, env: { ...prev?.env, SKILLROUTER_AGENT: agent } });

/** Wire the MCP server and (where the host has one) the prompt hook into one agent's user-scope config. Backs up every file it touches. */
export function install(agent: InstallTarget, home = HOME): string[] {
  const out: string[] = [];
  if ((AGENTS as string[]).includes(agent)) out.push(writeLauncher(NODE, CLI, home === HOME ? LAUNCHER : path.join(home, ".skillrouter", "bin", "skillrouter-hint")));
  const bin = home === HOME ? BIN : quote(path.join(home, ".skillrouter", "bin", "skillrouter-hint"));
  switch (agent) {
    case "claude":
      out.push(patchJson(path.join(home, ".claude", "settings.json"), (d) => [
        addHook(d, "UserPromptSubmit", { hooks: [{ type: "command", command: `${bin} claude`, timeout: 5 }] }),
        // Action triggers + skill-load logging, and the once-per-turn decision nudge.
        addHook(d, "PostToolUse", { matcher: CLAUDE_TOOL_MATCHER, hooks: [{ type: "command", command: `${bin} claude tool`, timeout: 5 }] }),
        addHook(d, "Stop", { hooks: [{ type: "command", command: `${bin} claude stop`, timeout: 5 }] }),
      ].join(", ")));
      out.push(patchJson(path.join(home, ".claude.json"), (d) => { (d.mcpServers ??= {}).skillrouter = { type: "stdio", ...mcpEntry(agent, d.mcpServers.skillrouter) }; return "skillrouter MCP set"; }));
      break;
    case "codex":
      out.push(patchJson(path.join(home, ".codex", "hooks.json"), (d) =>
        addHook(d, "UserPromptSubmit", { hooks: [{ type: "command", command: `${bin} codex`, timeout: 5 }] })));
      out.push(appendToml(path.join(home, ".codex", "config.toml"), `\n[mcp_servers.skillrouter]\n${TOML_MCP}\n[mcp_servers.skillrouter.env]\nSKILLROUTER_AGENT = "codex"\n`, "[mcp_servers.skillrouter]"));
      out.push("Codex asks you to trust a hook once; after that the launcher keeps its command text stable across reinstalls.");
      break;
    case "cursor":
      out.push(patchJson(path.join(home, ".cursor", "hooks.json"), (d) => addHook(d, "beforeSubmitPrompt", { command: `${bin} cursor` }), { version: 1, hooks: {} }));
      out.push(patchJson(path.join(home, ".cursor", "mcp.json"), (d) => { (d.mcpServers ??= {}).skillrouter = mcpEntry(agent, d.mcpServers.skillrouter); return "skillrouter MCP set"; }));
      break;
    case "gemini":
      out.push(patchJson(path.join(home, ".gemini", "settings.json"), (d) => {
        const h = addHook(d, "BeforeAgent", { hooks: [{ type: "command", command: `${bin} gemini`, timeout: 5000 }] });
        (d.mcpServers ??= {}).skillrouter = mcpEntry(agent, d.mcpServers.skillrouter);
        return h + " + skillrouter MCP";
      }));
      break;
    case "opencode": {
      const cfg = path.join(home, ".config", "opencode", "opencode.json");
      out.push(patchJson(cfg, (d) => { (d.mcp ??= {}).skillrouter = { ...d.mcp.skillrouter, type: "local", command: [MCP_CMD.command, ...MCP_CMD.args], enabled: true, environment: { ...d.mcp.skillrouter?.environment, SKILLROUTER_AGENT: agent } }; return "skillrouter MCP set"; }));
      const plugin = path.join(home, ".config", "opencode", "plugins", "skillrouter-hints.js");
      fs.mkdirSync(path.dirname(plugin), { recursive: true });
      fs.writeFileSync(plugin, openCodePlugin(home === HOME ? LAUNCHER : path.join(home, ".skillrouter", "bin", "skillrouter-hint")));
      out.push(`${plugin}: written`);
      break;
    }
    case "openclaude":
      out.push(patchJson(path.join(home, ".openclaude.json"), (d) => { (d.mcpServers ??= {}).skillrouter = { type: "stdio", ...mcpEntry(agent, d.mcpServers.skillrouter) }; return "skillrouter MCP set (no hooks on this host)"; }));
      break;
    case "antigravity":
      out.push(patchJson(path.join(home, ".gemini", "antigravity", "mcp_config.json"), (d) => { (d.mcpServers ??= {}).skillrouter = mcpEntry(agent, d.mcpServers.skillrouter); return "skillrouter MCP set (no hooks on this host)"; }));
      break;
    case "hermes":
      out.push(installHermes(home));
      break;
  }
  return out;
}

/** Hermes keeps MCP servers in ~/.hermes/config.yaml; its own config API writes it, so its comments and layout survive. */
function installHermes(home: string): string {
  const cfg = path.join(home, ".hermes", "config.yaml");
  const py = [path.join(home, ".hermes", "hermes-agent", "venv", "bin", "python"), path.join(home, ".hermes", "hermes-agent", ".venv", "bin", "python")].find((p) => fs.existsSync(p));
  if (!fs.existsSync(cfg)) return `${cfg}: missing (Hermes not installed); skipped`;
  if (!py) return `${cfg}: Hermes's Python not found under ~/.hermes/hermes-agent; add mcp_servers.skillrouter by hand: command ${NODE}, args [${CLI}, "mcp"], env SKILLROUTER_AGENT=hermes`;
  backup(cfg, fs.statSync(cfg).mode & 0o777);
  const script = `import sys, json; sys.path.insert(0, ${JSON.stringify(path.join(home, ".hermes", "hermes-agent"))})
from hermes_cli.config import load_config, save_config
c = load_config(); c.setdefault("mcp_servers", {})["skillrouter"] = json.loads(sys.argv[1]); save_config(c); print("ok")`;
  try {
    execFileSync(py, ["-c", script, JSON.stringify({ command: NODE, args: [CLI, "mcp"], env: { SKILLROUTER_AGENT: "hermes" } })], { cwd: path.join(home, ".hermes", "hermes-agent"), stdio: ["ignore", "pipe", "pipe"], timeout: 60000 });
    return `${cfg}: skillrouter MCP set via Hermes config API (no hooks on this host)`;
  } catch (e) {
    return `${cfg}: Hermes config API failed (${(e as Error).message.split("\n")[0]}); not changed`;
  }
}

function appendToml(file: string, block: string, marker: string): string {
  const cur = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const mode = cur ? fs.statSync(file).mode & 0o777 : undefined; // config.toml can hold keys: keep 0600
  if (cur) backup(file, mode);
  // Update only the keys owned by this installer, retaining other server settings/tables.
  let next = cur;
  for (const table of block.trim().split(/\n(?=\[)/)) {
    const [header, ...lines] = table.split("\n");
    const start = next.indexOf(header);
    if (start < 0) { next += `\n${table}\n`; continue; }
    const after = start + header.length;
    const boundary = next.slice(after).search(/\n\s*\[/);
    const end = boundary < 0 ? next.length : after + boundary;
    let body = next.slice(after, end);
    if (/^\s*(?:args|command)\s*=\s*(?:\[\s*$|["']{3})/m.test(body)) {
      throw new Error("Existing skillrouter TOML uses multiline command/args; preserve it and update those keys manually.");
    }
    for (const line of lines.filter(Boolean)) {
      const key = line.split("=")[0].trim();
      const pattern = new RegExp(`^[ \t]*${key}\\s*=.*$`, "m");
      body = pattern.test(body) ? body.replace(pattern, () => line) : body.trimEnd() + `\n${line}\n`;
    }
    next = next.slice(0, after) + body + next.slice(end);
  }
  fs.writeFileSync(file + ".tmp", next, mode !== undefined ? { mode } : {});
  if (mode !== undefined) fs.chmodSync(file + ".tmp", mode);
  fs.renameSync(file + ".tmp", file);
  return `${file}: updated ${marker}`;
}

/** The first install keeps the pristine copy; later installs don't overwrite it. */
function backup(file: string, mode?: number): void {
  const bak = `${file}.bak-skillrouter`;
  if (fs.existsSync(bak)) return;
  fs.copyFileSync(file, bak);
  if (mode !== undefined) fs.chmodSync(bak, mode);
}

// Hints ride on the user message they belong to and are re-applied every call, so the prompt-cache prefix stays stable.
export function openCodePlugin(command = LAUNCHER, args = ["opencode"], timeout = 2000): string { return `// skillrouter prompt hints for OpenCode (installed by: npx skillrouter install opencode)
import { spawn } from 'node:child_process';
const hints = new Map();
function ask(prompt, session_id) {
  return new Promise((resolve) => {
    const child = spawn(${JSON.stringify(command)}, ${JSON.stringify(args)}, { stdio: ['pipe', 'pipe', 'ignore'] });
    let out = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(''); }, ${timeout});
    child.stdout.on('data', (d) => { out += d; if (out.length > 65536) { child.kill('SIGKILL'); resolve(''); } });
    child.on('error', () => { clearTimeout(timer); resolve(''); });
    child.stdin.on('error', () => {});
    child.on('close', () => { clearTimeout(timer); try { resolve(JSON.parse(out).hookSpecificOutput.additionalContext || ''); } catch { resolve(''); } });
    child.stdin.end(JSON.stringify({ prompt, session_id }));
  });
}
export const SkillrouterHints = async () => ({
  'chat.message': async (_input, output) => {
    const id = output?.message?.id;
    const text = (output?.parts ?? []).filter((p) => p.type === 'text' && !p.synthetic).map((p) => p.text).join('\\n').trim();
    const hint = id ? await ask(text, output?.message?.sessionID) : '';
    if (hint) hints.set(id, hint);
  },
  'experimental.chat.messages.transform': async (_input, output) => {
    for (const m of output?.messages ?? []) {
      const hint = m?.info?.role === 'user' && hints.get(m.info.id);
      const base = hint && m.parts.find((p) => p.type === 'text');
      if (base && !m.parts.some((p) => p.id === base.id + '-skillrouter')) m.parts.push({ ...base, id: base.id + '-skillrouter', text: hint, synthetic: true });
    }
  },
});
`; }
