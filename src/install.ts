import fs from "node:fs";
import path from "node:path";
import { HOME, type AgentId } from "./paths.js";

const BIN = "npx -y skillrouter";
const MCP_CMD = { command: "npx", args: ["-y", "skillrouter", "mcp"] };

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

function addHook(d: any, event: string, entry: object): string {
  const list = ((d.hooks ??= {})[event] ??= []) as object[];
  if (list.some((e) => JSON.stringify(e).includes("skillrouter hint"))) return `${event} hook already present`;
  list.push(entry);
  return `added ${event} hook`;
}

/** Wire the MCP server and the prompt hook into one agent's user-scope config. Backs up every file it touches. */
export function install(agent: AgentId): string[] {
  const out: string[] = [];
  switch (agent) {
    case "claude":
      out.push(patchJson(path.join(HOME, ".claude", "settings.json"), (d) =>
        addHook(d, "UserPromptSubmit", { hooks: [{ type: "command", command: `${BIN} hint claude`, timeout: 5 }] })));
      out.push(patchJson(path.join(HOME, ".claude.json"), (d) => { (d.mcpServers ??= {}).skillrouter = { type: "stdio", ...MCP_CMD }; return "skillrouter MCP set"; }));
      break;
    case "codex":
      out.push(patchJson(path.join(HOME, ".codex", "hooks.json"), (d) =>
        addHook(d, "UserPromptSubmit", { hooks: [{ type: "command", command: `${BIN} hint codex`, timeout: 5 }] })));
      out.push(appendToml(path.join(HOME, ".codex", "config.toml"), `\n[mcp_servers.skillrouter]\ncommand = "npx"\nargs = ["-y", "skillrouter", "mcp"]\n`, "[mcp_servers.skillrouter]"));
      out.push("Codex asks you to trust new hooks on next start; run `codex` and approve the skillrouter hook.");
      break;
    case "cursor":
      out.push(patchJson(path.join(HOME, ".cursor", "hooks.json"), (d) => addHook(d, "beforeSubmitPrompt", { command: `${BIN} hint cursor` }), { version: 1, hooks: {} }));
      out.push(patchJson(path.join(HOME, ".cursor", "mcp.json"), (d) => { (d.mcpServers ??= {}).skillrouter = MCP_CMD; return "skillrouter MCP set"; }));
      break;
    case "gemini":
      out.push(patchJson(path.join(HOME, ".gemini", "settings.json"), (d) => {
        const h = addHook(d, "BeforeAgent", { hooks: [{ type: "command", command: `${BIN} hint gemini`, timeout: 5000 }] });
        (d.mcpServers ??= {}).skillrouter = MCP_CMD;
        return h + " + skillrouter MCP";
      }));
      break;
    case "opencode": {
      const cfg = path.join(HOME, ".config", "opencode", "opencode.json");
      out.push(patchJson(cfg, (d) => { (d.mcp ??= {}).skillrouter = { type: "local", command: ["npx", "-y", "skillrouter", "mcp"], enabled: true }; return "skillrouter MCP set"; }));
      const plugin = path.join(HOME, ".config", "opencode", "plugins", "skillrouter-hints.js");
      fs.mkdirSync(path.dirname(plugin), { recursive: true });
      fs.writeFileSync(plugin, OPENCODE_PLUGIN);
      out.push(`${plugin}: written`);
      break;
    }
  }
  return out;
}

function appendToml(file: string, block: string, marker: string): string {
  const cur = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  if (cur.includes(marker)) return `${file}: ${marker} already present`;
  if (cur) fs.copyFileSync(file, `${file}.bak-skillrouter`);
  fs.appendFileSync(file, block);
  return `${file}: added ${marker}`;
}

// Hints ride on the user message they belong to and are re-applied every call, so the prompt-cache prefix stays stable.
const OPENCODE_PLUGIN = `// skillrouter prompt hints for OpenCode (installed by: npx skillrouter install opencode)
import { spawn } from 'node:child_process';
const hints = new Map();
function ask(prompt) {
  return new Promise((resolve) => {
    const child = spawn('npx', ['-y', 'skillrouter', 'hint', 'claude'], { stdio: ['pipe', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.on('error', () => resolve(''));
    child.on('close', () => { try { resolve(JSON.parse(out).hookSpecificOutput.additionalContext || ''); } catch { resolve(''); } });
    child.stdin.end(JSON.stringify({ prompt }));
  });
}
export const SkillrouterHints = async () => ({
  'chat.message': async (_input, output) => {
    const id = output?.message?.id;
    const text = (output?.parts ?? []).filter((p) => p.type === 'text' && !p.synthetic).map((p) => p.text).join('\\n').trim();
    const hint = id ? await ask(text) : '';
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
`;
