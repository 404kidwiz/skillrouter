import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { HOME, SR_DIR, AGENTS, type AgentId } from "./paths.js";
import { PERL_CLIENT, socketPath } from "./service-client.js";

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

/**
 * The launcher every hook calls. With Perl available it hands the hook to the Perl client (see PERL_CLIENT), which
 * asks the warm service, starts one when needed, and otherwise runs Node exactly as before, so the service can only
 * ever make hooks faster. Without Perl, or with SKILLROUTER_SERVICE=0, or if Perl cannot run the client at all
 * (exit 2 or 255, before it has touched stdin), Node runs the hook directly and asks the service itself.
 */
export function launcherScript(node: string, cli: string, perlClient: string, dir: string, sock: string): string {
  return `#!/bin/sh
# skillrouter hook launcher. Rewritten by \`skillrouter install\`; hook configs point here so their text never changes.
if [ "\${SKILLROUTER_SERVICE:-1}" != 0 ] && [ -f ${quote(perlClient)} ] && command -v perl >/dev/null 2>&1; then
  perl ${quote(perlClient)} ${quote(dir)} ${quote(sock)} ${quote(node)} ${quote(cli)} "$@"
  rc=$?
  if [ $rc -ne 2 ] && [ $rc -ne 255 ]; then exit $rc; fi
fi
exec ${quote(node)} ${quote(cli)} hint "$@"
`;
}

export function writeLauncher(node = NODE, cli = CLI, launcher = LAUNCHER): string {
  fs.mkdirSync(path.dirname(launcher), { recursive: true });
  const perlClient = path.join(path.dirname(launcher), "skillrouter-client.pl");
  const dir = path.dirname(path.dirname(launcher));
  const sock = socketPath(dir);
  const write = (file: string, body: string) => { fs.writeFileSync(file + ".tmp", body, { mode: 0o755 }); fs.renameSync(file + ".tmp", file); fs.chmodSync(file, 0o755); };
  write(perlClient, PERL_CLIENT);
  write(launcher, launcherScript(node, cli, perlClient, dir, sock));
  return `${launcher}: execs ${node} ${cli} (warm service socket ${sock})`;
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
  // Reinstalling keeps the router's position: hosts that key hook trust by position (Codex) don't re-flag other hooks.
  let at = list.findIndex((item) => isRouterHook(item));
  // Replace only router commands, preserving unrelated commands grouped in the same entry.
  for (let i = list.length - 1; i >= 0; i--) {
    const item = list[i] as { hooks?: unknown[] };
    if (!isRouterHook(item)) continue;
    if (Array.isArray(item.hooks)) {
      item.hooks = item.hooks.filter((h) => !isRouterHook(h));
      if (item.hooks.length) continue;
    }
    list.splice(i, 1);
    if (i < at) at--;
  }
  if (at < 0 || at > list.length) list.push(entry);
  else list.splice(at, 0, entry);
  return `added ${event} hook`;
}

// The router's read_skill is mcp__skillrouter__read_skill when installed here and mcp__plugin_…skillrouter__read_skill from the plugin.
export const CLAUDE_TOOL_MATCHER = "Edit|Write|MultiEdit|NotebookEdit|Bash|Skill|mcp__.*skillrouter__read_skill";
// Codex reports shell and exec_command as Bash and file edits as apply_patch.
export const CODEX_TOOL_MATCHER = "Bash|apply_patch|mcp__skillrouter__read_skill";
// Cursor's hook names (Shell, Write, MCP:<tool>) plus its edit tools' own names. Not Read: every match is a process
// spawn, and the stop check sees SKILL.md reads in Cursor's transcript anyway.
export const CURSOR_TOOL_MATCHER = "Shell|Write|StrReplace|Edit|MultiEdit|ApplyPatch|MCP:read_skill";
export const GEMINI_TOOL_MATCHER = "write_file|replace|run_shell_command|activate_skill|mcp_skillrouter_read_skill";

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
      out.push(patchJson(path.join(home, ".codex", "hooks.json"), (d) => [
        addHook(d, "UserPromptSubmit", { hooks: [{ type: "command", command: `${bin} codex`, timeout: 5 }] }),
        addHook(d, "PostToolUse", { matcher: CODEX_TOOL_MATCHER, hooks: [{ type: "command", command: `${bin} codex tool`, timeout: 5 }] }),
        addHook(d, "Stop", { hooks: [{ type: "command", command: `${bin} codex stop`, timeout: 5 }] }),
      ].join(", ")));
      out.push(appendToml(path.join(home, ".codex", "config.toml"), `\n[mcp_servers.skillrouter]\n${TOML_MCP}\n[mcp_servers.skillrouter.env]\nSKILLROUTER_AGENT = "codex"\n`, "[mcp_servers.skillrouter]"));
      out.push("Codex asks you to trust each new hook once (/hooks in Codex); after that the launcher keeps its command text stable across reinstalls.");
      break;
    case "cursor":
      out.push(patchJson(path.join(home, ".cursor", "hooks.json"), (d) => [
        addHook(d, "beforeSubmitPrompt", { command: `${bin} cursor` }),
        addHook(d, "postToolUse", { command: `${bin} cursor tool`, matcher: CURSOR_TOOL_MATCHER, timeout: 5 }),
        // One follow-up at most (Cursor's default allows 5); skillrouter also never nudges a turn that is itself a follow-up.
        addHook(d, "stop", { command: `${bin} cursor stop`, timeout: 5, loop_limit: 1 }),
      ].join(", "), { version: 1, hooks: {} }));
      out.push(patchJson(path.join(home, ".cursor", "mcp.json"), (d) => { (d.mcpServers ??= {}).skillrouter = mcpEntry(agent, d.mcpServers.skillrouter); return "skillrouter MCP set"; }));
      break;
    case "gemini":
      out.push(patchJson(path.join(home, ".gemini", "settings.json"), (d) => {
        const h = [
          addHook(d, "BeforeAgent", { hooks: [{ type: "command", command: `${bin} gemini`, timeout: 5000 }] }),
          addHook(d, "AfterTool", { matcher: GEMINI_TOOL_MATCHER, hooks: [{ type: "command", command: `${bin} gemini tool`, timeout: 5000 }] }),
          addHook(d, "AfterAgent", { hooks: [{ type: "command", command: `${bin} gemini stop`, timeout: 5000 }] }),
        ].join(", ");
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

// Prompt hints ride on the user message they belong to and are re-applied every call, so the prompt-cache prefix
// stays stable. Trigger hints are appended to the tool result that showed the kind of work.
export function openCodePlugin(command = LAUNCHER, args = ["opencode"], timeout = 2000): string { return `// skillrouter hints for OpenCode (installed by: npx skillrouter install opencode)
import { spawn } from 'node:child_process';
const hints = new Map();
const decided = new Set(); // turns whose decision was sent
const current = new Map(); // session -> its latest prompt (message id), so trigger checks belong to that turn
// Only tools that show the kind of work (or load a skill) start a process.
const TOOLS = /^(bash|edit|write|multiedit|patch|apply_patch|skill)$|read_skill$/;
function ask(payload, mode) {
  return new Promise((resolve) => {
    const child = spawn(${JSON.stringify(command)}, [...${JSON.stringify(args)}, ...(mode ? [mode] : [])], { stdio: ['pipe', 'pipe', 'ignore'] });
    let out = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(''); }, ${timeout});
    child.stdout.on('data', (d) => { out += d; if (out.length > 65536) { child.kill('SIGKILL'); resolve(''); } });
    child.on('error', () => { clearTimeout(timer); resolve(''); });
    child.stdin.on('error', () => {});
    child.on('close', () => { clearTimeout(timer); try { resolve(JSON.parse(out).hookSpecificOutput.additionalContext || ''); } catch { resolve(''); } });
    child.stdin.end(JSON.stringify(payload));
  });
}
export const SkillrouterHints = async (ctx) => ({
  'chat.message': async (_input, output) => {
    const id = output?.message?.id;
    const text = (output?.parts ?? []).filter((p) => p.type === 'text' && !p.synthetic).map((p) => p.text).join('\\n').trim();
    if (id) current.set(output?.message?.sessionID, id);
    const hint = id ? await ask({ prompt: text, session_id: output?.message?.sessionID, prompt_id: id }) : '';
    if (hint) hints.set(id, hint);
  },
  'tool.execute.after': async (input, output) => {
    if (!TOOLS.test(input?.tool ?? '') || typeof output?.output !== 'string') return;
    const hint = await ask({ session_id: input.sessionID, prompt_id: current.get(input.sessionID), tool_use_id: input.callID, tool_name: input.tool, tool_input: input.args, cwd: ctx?.directory }, 'tool');
    if (hint) output.output += '\\n\\n' + hint;
  },
  'experimental.chat.messages.transform': async (_input, output) => {
    const messages = output?.messages ?? [];
    for (const m of messages) {
      const hint = m?.info?.role === 'user' && hints.get(m.info.id);
      const base = hint && m.parts.find((p) => p.type === 'text');
      if (base && !m.parts.some((p) => p.id === base.id + '-skillrouter')) m.parts.push({ ...base, id: base.id + '-skillrouter', text: hint, synthetic: true });
    }
    // No end-of-turn hook here: a turn is over once the model has started answering a newer prompt (a prompt
    // queued mid-turn doesn't end it) and all its replies are complete. Each finished turn's text is sent once,
    // for the last few turns only, so skillrouter can record what was decided about its checks.
    const turns = new Map();
    let answering;
    for (const m of messages) {
      const i = m?.info;
      if (i?.role !== 'assistant' || !i.parentID) continue;
      answering = i.parentID;
      const t = turns.get(i.parentID) ?? { session_id: i.sessionID, prompt_id: i.parentID, text: '', done: true };
      t.done = t.done && !!i.time?.completed;
      const text = (m.parts ?? []).filter((p) => p.type === 'text' && !p.synthetic).map((p) => p.text).join('\\n');
      t.text = t.text ? t.text + '\\n' + text : text;
      turns.set(i.parentID, t);
    }
    const ended = [...turns.values()].filter((t) => t.done && t.prompt_id !== answering && !decided.has(t.prompt_id));
    for (const { done, ...payload } of ended.slice(-3)) { decided.add(payload.prompt_id); ask(payload, 'decision'); }
  },
});
`; }
