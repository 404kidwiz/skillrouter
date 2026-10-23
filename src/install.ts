import fs from "node:fs";
import path from "node:path";
import { HOME, type AgentId } from "./paths.js";

// Pin both integrations to this installed package; prompt submission never invokes npm.
import { fileURLToPath } from "node:url";
const CLI = fileURLToPath(new URL("./cli.js", import.meta.url));

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
const BIN = `${quote(NODE)} ${quote(CLI)}`;
const MCP_CMD = { command: NODE, args: [CLI, "mcp"] };
const TOML_MCP = `command = ${JSON.stringify(NODE)}\nargs = [${JSON.stringify(CLI)}, "mcp"]`;

export function isRouterHook(entry: unknown): boolean {
  if (!entry || typeof entry !== "object") return false;
  const value = entry as { command?: unknown; hooks?: unknown[] };
  return (typeof value.command === "string" && /(?:skillrouter|cli\.js['"]?)\s+hint\s+(?:claude|codex|cursor|gemini|opencode)\b/.test(value.command)) ||
    (Array.isArray(value.hooks) && value.hooks.some(isRouterHook));
}

function patchJson(file: string, fn: (d: any) => string, create: object = {}): string {
  let d: any = create;
  if (fs.existsSync(file)) {
    fs.copyFileSync(file, `${file}.bak-skillrouter`);
    d = JSON.parse(fs.readFileSync(file, "utf8"));
  } else fs.mkdirSync(path.dirname(file), { recursive: true });
  const msg = fn(d);
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(d, null, 2) + "\n");
  JSON.parse(fs.readFileSync(tmp, "utf8"));
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

/** Wire the MCP server and the prompt hook into one agent's user-scope config. Backs up every file it touches. */
export function install(agent: AgentId, home = HOME): string[] {
  const out: string[] = [];
  switch (agent) {
    case "claude":
      out.push(patchJson(path.join(home, ".claude", "settings.json"), (d) =>
        addHook(d, "UserPromptSubmit", { hooks: [{ type: "command", command: `${BIN} hint claude`, timeout: 5 }] })));
      out.push(patchJson(path.join(home, ".claude.json"), (d) => { (d.mcpServers ??= {}).skillrouter = { ...d.mcpServers.skillrouter, type: "stdio", ...MCP_CMD, env: { ...d.mcpServers.skillrouter?.env, SKILLROUTER_AGENT: agent } }; return "skillrouter MCP set"; }));
      break;
    case "codex":
      out.push(patchJson(path.join(home, ".codex", "hooks.json"), (d) =>
        addHook(d, "UserPromptSubmit", { hooks: [{ type: "command", command: `${BIN} hint codex`, timeout: 5 }] })));
      out.push(appendToml(path.join(home, ".codex", "config.toml"), `\n[mcp_servers.skillrouter]\n${TOML_MCP}\n[mcp_servers.skillrouter.env]\nSKILLROUTER_AGENT = "codex"\n`, "[mcp_servers.skillrouter]"));
      out.push("Codex asks you to trust new hooks on next start; run `codex` and approve the skillrouter hook.");
      break;
    case "cursor":
      out.push(patchJson(path.join(home, ".cursor", "hooks.json"), (d) => addHook(d, "beforeSubmitPrompt", { command: `${BIN} hint cursor` }), { version: 1, hooks: {} }));
      out.push(patchJson(path.join(home, ".cursor", "mcp.json"), (d) => { (d.mcpServers ??= {}).skillrouter = { ...d.mcpServers.skillrouter, ...MCP_CMD, env: { ...d.mcpServers.skillrouter?.env, SKILLROUTER_AGENT: agent } }; return "skillrouter MCP set"; }));
      break;
    case "gemini":
      out.push(patchJson(path.join(home, ".gemini", "settings.json"), (d) => {
        const h = addHook(d, "BeforeAgent", { hooks: [{ type: "command", command: `${BIN} hint gemini`, timeout: 5000 }] });
        (d.mcpServers ??= {}).skillrouter = { ...d.mcpServers.skillrouter, ...MCP_CMD, env: { ...d.mcpServers.skillrouter?.env, SKILLROUTER_AGENT: agent } };
        return h + " + skillrouter MCP";
      }));
      break;
    case "opencode": {
      const cfg = path.join(home, ".config", "opencode", "opencode.json");
      out.push(patchJson(cfg, (d) => { (d.mcp ??= {}).skillrouter = { ...d.mcp.skillrouter, type: "local", command: [MCP_CMD.command, ...MCP_CMD.args], enabled: true, environment: { ...d.mcp.skillrouter?.environment, SKILLROUTER_AGENT: agent } }; return "skillrouter MCP set"; }));
      const plugin = path.join(home, ".config", "opencode", "plugins", "skillrouter-hints.js");
      fs.mkdirSync(path.dirname(plugin), { recursive: true });
      fs.writeFileSync(plugin, openCodePlugin());
      out.push(`${plugin}: written`);
      break;
    }
  }
  return out;
}

function appendToml(file: string, block: string, marker: string): string {
  const cur = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (cur) fs.copyFileSync(file, `${file}.bak-skillrouter`);
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
  fs.writeFileSync(file + ".tmp", next);
  fs.renameSync(file + ".tmp", file);
  return `${file}: updated ${marker}`;
}

// Hints ride on the user message they belong to and are re-applied every call, so the prompt-cache prefix stays stable.
export function openCodePlugin(command = NODE, args = [CLI, "hint", "opencode"], timeout = 2000): string { return `// skillrouter prompt hints for OpenCode (installed by: npx skillrouter install opencode)
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
