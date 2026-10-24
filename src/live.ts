import fs from "node:fs";
import { parseJson } from "./platform.js";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { HOME, antigravityConfigPaths } from "./paths.js";
import { INSTALL_TARGETS, type InstallTarget } from "./install.js";

export interface McpSpec { command: string; args: string[]; env: Record<string, string>; disabled?: boolean }

function json(file: string): any { try { return parseJson(fs.readFileSync(file, "utf8")); } catch { return undefined; } }

const unquote = (s: string) => s.trim().replace(/^(["'])(.*)\1$/, "$2");
/** A TOML/YAML string or a flow/inline array of them. */
const strings = (s: string) => [...s.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'|([^\s,\[\]]+)/g)].map((m) => m[1] ?? m[2] ?? m[3]);

/** Enough TOML for the table `install` writes (and a hand-edited one): quoted strings, arrays, inline or sub-table env. */
export function codexSpec(toml: string): McpSpec | null {
  const sec = toml.match(/^\[mcp_servers\.skillrouter\][ \t]*\r?\n([^]*?)(?=^\[|$(?![^]))/m)?.[1];
  if (!sec) return null;
  const command = sec.match(/^command\s*=\s*(.+)$/m)?.[1];
  const args = strings(sec.match(/^args\s*=\s*\[([^\]]*)\]/m)?.[1] ?? "");
  const inlineEnv = sec.match(/^env\s*=\s*\{([^}]*)\}/m)?.[1] ?? "";
  const subEnv = toml.match(/^\[mcp_servers\.skillrouter\.env\][ \t]*\r?\n([^]*?)(?=^\[|$(?![^]))/m)?.[1] ?? "";
  const env = Object.fromEntries([...`${inlineEnv}\n${subEnv}`.matchAll(/(\w+)\s*=\s*("(?:[^"\\]|\\.)*"|'[^']*')/g)].map((m) => [m[1], unquote(m[2])]));
  const disabled = /^enabled\s*=\s*false/m.test(sec);
  return command ? { command: unquote(command), args, env, disabled } : null;
}

/** Enough YAML for the block Hermes's own writer emits: plain or quoted scalars (spaces included), block or flow lists. */
export function hermesSpec(yaml: string): McpSpec | null {
  const servers = yaml.match(/^mcp_servers:[ \t]*\r?\n([^]*?)(?=^\S|$(?![^]))/m)?.[1];
  const block = servers?.match(/^  skillrouter:[ \t]*\r?\n((?:[ \t]{4,}.*(?:\r?\n|$)|[ \t]*\r?\n)*)/m)?.[1];
  if (!block) return null;
  const value = (key: string) => block.match(new RegExp(`^ {4}${key}:[ \\t]*(.*)$`, "m"))?.[1];
  const command = value("command");
  const argsLine = value("args") ?? "";
  const args = argsLine.trim().startsWith("[")
    ? strings(argsLine.trim().slice(1, -1))
    : [...(block.match(/^ {4}args:[ \t]*\r?\n((?:[ \t]{6,}- .*(?:\r?\n|$))*)/m)?.[1] ?? "").matchAll(/^[ \t]+- (.*)$/gm)].map((m) => unquote(m[1]));
  const envBlock = block.match(/^ {4}env:[ \t]*\r?\n((?:[ \t]{6,}.*(?:\r?\n|$))*)/m)?.[1] ?? "";
  const env = Object.fromEntries([...envBlock.matchAll(/^[ \t]+(\w+):[ \t]*(.*)$/gm)].map((m) => [m[1], unquote(m[2])]));
  return command ? { command: unquote(command), args, env } : null;
}

/** The MCP command each host's user-scope config would run for skillrouter, or null when not configured. */
export function mcpSpec(target: InstallTarget, home = HOME): McpSpec | null {
  const f = (...p: string[]) => path.join(home, ...p);
  const norm = (e: any): McpSpec | null => {
    if (!e) return null;
    const command = Array.isArray(e.command) ? e.command[0] : e.command;
    const args = Array.isArray(e.command) ? e.command.slice(1) : e.args ?? [];
    return typeof command === "string" ? { command, args, env: { ...(e.env ?? e.environment ?? {}) }, disabled: e.disabled === true || e.enabled === false } : null;
  };
  const read = (file: string) => { try { return fs.readFileSync(file, "utf8"); } catch { return null; } };
  switch (target) {
    case "claude": return norm(json(f(".claude.json"))?.mcpServers?.skillrouter);
    case "cursor": return norm(json(f(".cursor", "mcp.json"))?.mcpServers?.skillrouter);
    case "gemini": return norm(json(f(".gemini", "settings.json"))?.mcpServers?.skillrouter);
    case "opencode": return norm(json(f(".config", "opencode", "opencode.json"))?.mcp?.skillrouter);
    case "openclaude": return norm(json(f(".openclaude.json"))?.mcpServers?.skillrouter);
    case "antigravity": return norm(json(antigravityConfigPaths(home).current)?.mcpServers?.skillrouter);
    case "codex": { const t = read(f(".codex", "config.toml")); return t === null ? null : codexSpec(t); }
    case "hermes": { const y = read(f(".hermes", "config.yaml")); return y === null ? null : hermesSpec(y); }
  }
}

/** Actually start each configured skillrouter server and list its tools: the proof `doctor` otherwise lacks. */
export async function liveCheck(targets: InstallTarget[] = INSTALL_TARGETS, home = HOME, timeoutMs = 15000): Promise<string[]> {
  const out: string[] = [];
  for (const target of targets) {
    const spec = mcpSpec(target, home);
    if (!spec) { out.push(`  ${target}: not configured`); continue; }
    if (spec.disabled) { out.push(`  ${target}: disabled in its config; not started`); continue; }
    const base = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => typeof e[1] === "string"));
    const client = new Client({ name: "skillrouter-doctor-live", version: "1" });
    const started = Date.now();
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error(`no answer within ${timeoutMs} ms`)), timeoutMs); });
    try {
      const transport = new StdioClientTransport({ command: spec.command, args: spec.args, env: { ...base, ...spec.env } });
      const tools = await Promise.race([
        client.connect(transport).then(() => client.listTools()).then((r) => r.tools.map((t) => t.name)),
        deadline,
      ]);
      out.push(`  ${target}: connected in ${Date.now() - started} ms; tools ${tools.join(", ")}${spec.env.SKILLROUTER_AGENT ? "" : " (no SKILLROUTER_AGENT: usage will be unattributed)"}`);
    } catch (e) {
      out.push(`  ${target}: FAILED (${(e as Error).message.split("\n")[0]}) running ${spec.command} ${spec.args.join(" ")}`);
    } finally {
      clearTimeout(timer); // otherwise the pending timer keeps the process alive for the full timeout
      await client.close().catch(() => {});
    }
  }
  return out;
}
