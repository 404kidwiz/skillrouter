import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { HOME, SR_DIR, AGENTS, antigravityConfigPaths } from "./paths.js";
import { PERL_CLIENT, socketPath } from "./service-client.js";
import { MCP_ONLY, INSTALL_TARGETS, LAUNCHER, NODE_FALLBACKS, managedNode, volatileNode, isRouterHook, pinProblems } from "./pins.js";
export { MCP_ONLY, INSTALL_TARGETS, LAUNCHER, NODE_FALLBACKS, volatileNode, isRouterHook, pinProblems };
import { NO_WINDOW, fwd, hookPrefix, launcherFile, parseJson, renameSyncRetry, windowsLauncher } from "./platform.js";
// Pin both integrations to this installed package; prompt submission never invokes npm.
import { fileURLToPath } from "node:url";
const CLI = fileURLToPath(new URL("./cli.js", import.meta.url));
/**
 * The Node hooks and MCP entries are pinned to: the one running us when its path is stable; otherwise the first
 * stable `node` on PATH, then in the usual system locations, that is new enough (>= 20). The path is judged as
 * written, so a stable link (/opt/homebrew/bin/node) counts even though it resolves into a versioned folder; a
 * link into a managed tree does not. SKILLROUTER_NODE overrides. With nothing stable, the running Node is kept
 * (and `doctor` says so).
 */
export function resolveNode() {
    if (process.env.SKILLROUTER_NODE)
        return process.env.SKILLROUTER_NODE;
    const real = (p) => { try {
        return fs.realpathSync(p);
    }
    catch {
        return p;
    } };
    const managed = (p) => managedNode(p) || managedNode(real(p));
    if (!volatileNode(process.execPath) && !managed(process.execPath))
        return process.execPath;
    const usable = (cand) => {
        try {
            if (!fs.statSync(cand).isFile() || volatileNode(cand) || managed(cand))
                return false;
            if (real(cand) === real(process.execPath))
                return true; // the same binary under a stable name
            const v = execFileSync(cand, ["-v"], { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"], ...NO_WINDOW }).trim();
            return Number(v.replace(/^v/, "").split(".")[0]) >= 20;
        }
        catch {
            return false;
        }
    };
    const name = process.platform === "win32" ? "node.exe" : "node";
    const onPath = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean).map((dir) => path.resolve(dir, name)); // a relative PATH entry must not become a relative pin
    for (const cand of [...new Set([...onPath, ...(process.platform === "win32" ? [] : NODE_FALLBACKS)])])
        if (usable(cand))
            return cand;
    // Nothing stable: at least avoid a managed tree, as before, with a Node that is new enough.
    if (!managed(process.execPath))
        return process.execPath;
    const recent = (cand) => { try {
        return Number(execFileSync(cand, ["-v"], { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"], ...NO_WINDOW }).trim().replace(/^v/, "").split(".")[0]) >= 20;
    }
    catch {
        return false;
    } };
    for (const cand of onPath) {
        try {
            if (fs.statSync(cand).isFile() && !managed(cand) && recent(cand))
                return cand;
        }
        catch { /* not here */ }
    }
    return process.execPath;
}
export const NODE = resolveNode();
const quote = (value) => "'" + value.replace(/'/g, "'\\''") + "'";
/** What the configs are pointed at: this package's CLI, or the snapshot `skillrouter install` made of it (snapshotApp). */
const target = { cli: CLI };
export function setInstallCli(cli) { target.cli = cli; }
const mcpCmd = () => ({ command: NODE, args: [target.cli, "mcp"] });
const tomlMcp = () => `command = ${JSON.stringify(NODE)}\nargs = [${JSON.stringify(target.cli)}, "mcp"]`;
/**
 * The launcher every hook calls. With Perl available it hands the hook to the Perl client (see PERL_CLIENT), which
 * asks the warm service, starts one when needed, and otherwise runs Node exactly as before, so the service can only
 * ever make hooks faster. Without Perl, or with SKILLROUTER_SERVICE=0, or if Perl cannot run the client at all
 * (exit 2 or 255, before it has touched stdin), Node runs the hook directly and asks the service itself.
 */
export function launcherScript(node, cli, perlClient, dir, sock) {
    return `#!/bin/sh
# skillrouter hook launcher. Rewritten by \`skillrouter install\`; hook configs point here so their text never changes.
NODE=${quote(node)}
# The pinned Node is gone (an update or cleanup removed it): use another one, new enough, rather than fail every hook.
if [ ! -x "$NODE" ]; then
  for c in "$(command -v node 2>/dev/null)" ${NODE_FALLBACKS.map(quote).join(" ")}; do
    if [ -n "$c" ] && [ -x "$c" ] && "$c" -e 'process.exit(+process.versions.node.split(".")[0] >= 20 ? 0 : 1)' </dev/null 2>/dev/null; then NODE="$c"; break; fi
  done
fi
if [ "\${SKILLROUTER_SERVICE:-1}" != 0 ] && [ -f ${quote(perlClient)} ] && command -v perl >/dev/null 2>&1; then
  perl ${quote(perlClient)} ${quote(dir)} ${quote(sock)} "$NODE" ${quote(cli)} "$@"
  rc=$?
  if [ $rc -ne 2 ] && [ $rc -ne 255 ]; then exit $rc; fi
fi
# Nothing can run the hook (no Node, or the code is gone): a host that needs an answer still gets its "go ahead".
if [ ! -x "$NODE" ] || [ ! -f ${quote(cli)} ]; then
  case "$1:$2" in antigravity:gate) echo '{"decision":"allow"}'; exit 0;; antigravity:*|hermes:*) echo '{}'; exit 0;; esac
fi
exec "$NODE" ${quote(cli)} hint "$@"
`;
}
export function writeLauncher(node = NODE, cli = CLI, launcher = LAUNCHER, platform = process.platform) {
    fs.mkdirSync(path.dirname(launcher), { recursive: true });
    if (platform === "win32") {
        // No shell script and no Perl: a module `node` runs that hands the hook to the CLI in the same process, whose Node client asks the service.
        const file = launcherFile(launcher, "win32");
        fs.writeFileSync(`${file}.tmp-${process.pid}`, windowsLauncher(cli));
        renameSyncRetry(`${file}.tmp-${process.pid}`, file);
        return `${file}: runs ${cli} (node from PATH; warm service over a named pipe)`;
    }
    const perlClient = path.join(path.dirname(launcher), "skillrouter-client.pl");
    const dir = path.dirname(path.dirname(launcher));
    const sock = socketPath(dir);
    const write = (file, body) => { fs.writeFileSync(`${file}.tmp-${process.pid}`, body, { mode: 0o755 }); renameSyncRetry(`${file}.tmp-${process.pid}`, file); fs.chmodSync(file, 0o755); };
    write(perlClient, PERL_CLIENT);
    write(launcher, launcherScript(node, cli, perlClient, dir, sock));
    return `${launcher}: execs ${node} ${cli} (warm service socket ${sock})`;
}
function patchJson(file, fn, create = {}) {
    let d = create;
    let mode;
    if (fs.existsSync(file)) {
        mode = fs.statSync(file).mode & 0o777; // a config holding keys (0600) keeps its permissions
        backup(file, mode);
        d = parseJson(fs.readFileSync(file, "utf8"));
    }
    else
        fs.mkdirSync(path.dirname(file), { recursive: true });
    const msg = fn(d);
    const tmp = `${file}.tmp-${process.pid}`; // per process: two installs at once must not share a half-written file
    fs.writeFileSync(tmp, JSON.stringify(d, null, 2) + "\n", mode !== undefined ? { mode } : {});
    JSON.parse(fs.readFileSync(tmp, "utf8"));
    if (mode !== undefined)
        fs.chmodSync(tmp, mode);
    renameSyncRetry(tmp, file);
    return `${file}: ${msg}`;
}
export function addHook(d, event, entry) {
    const list = ((d.hooks ??= {})[event] ??= []);
    // Reinstalling keeps the router's position: hosts that key hook trust by position (Codex) don't re-flag other hooks.
    let at = list.findIndex((item) => isRouterHook(item));
    // Replace only router commands, preserving unrelated commands grouped in the same entry.
    for (let i = list.length - 1; i >= 0; i--) {
        const item = list[i];
        if (!isRouterHook(item))
            continue;
        if (Array.isArray(item.hooks)) {
            item.hooks = item.hooks.filter((h) => !isRouterHook(h));
            if (item.hooks.length)
                continue;
        }
        list.splice(i, 1);
        if (i < at)
            at--;
    }
    if (at < 0 || at > list.length)
        list.push(entry);
    else
        list.splice(at, 0, entry);
    return `added ${event} hook`;
}
// The router's read_skill is mcp__skillrouter__read_skill when installed here and mcp__plugin_…skillrouter__read_skill from the plugin.
export const CLAUDE_TOOL_MATCHER = "Edit|Write|MultiEdit|NotebookEdit|Bash|PowerShell|Skill|mcp__.*skillrouter__read_skill";
// The search gate (gate.ts) judges work calls (edits and commands) and also sees searches and skill loads, so it learns about
// them itself and does not depend on the post-tool hook (Codex runs a hook only once the user has trusted it). Cursor loads a
// skill by reading its SKILL.md, hence Read there.
export const CLAUDE_GATE_MATCHER = "Edit|Write|MultiEdit|NotebookEdit|Bash|PowerShell|Skill|mcp__.*skillrouter__(?:read_skill|search_skills)";
export const CODEX_GATE_MATCHER = "Bash|apply_patch|mcp__skillrouter__(?:read_skill|search_skills)";
export const CURSOR_GATE_MATCHER = "Shell|Write|StrReplace|Edit|MultiEdit|ApplyPatch|Read|MCP:(?:read_skill|search_skills)";
export const GEMINI_GATE_MATCHER = "write_file|replace|run_shell_command|activate_skill|mcp_skillrouter_(?:read_skill|search_skills)";
// Codex reports shell and exec_command as Bash and file edits as apply_patch.
export const CODEX_TOOL_MATCHER = "Bash|apply_patch|mcp__skillrouter__read_skill";
// Cursor's hook names (Shell, Write, MCP:<tool>) plus its edit tools' own names. Not Read: every match is a process
// spawn, and the stop check sees SKILL.md reads in Cursor's transcript anyway.
export const CURSOR_TOOL_MATCHER = "Shell|Write|StrReplace|Edit|MultiEdit|ApplyPatch|MCP:read_skill";
export const GEMINI_TOOL_MATCHER = "write_file|replace|run_shell_command|activate_skill|mcp_skillrouter_read_skill";
const mcpEntry = (agent, prev = {}) => ({ ...prev, ...mcpCmd(), env: { ...prev?.env, SKILLROUTER_AGENT: agent } });
export function install(agent, home = HOME, platform = process.platform, opts = {}) {
    const out = [];
    const base = home === HOME ? LAUNCHER : path.join(home, ".skillrouter", "bin", "skillrouter-hint");
    const launcher = launcherFile(base, platform);
    const hooked = AGENTS.includes(agent) || (agent === "hermes" && fs.existsSync(path.join(home, ".hermes", "config.yaml"))) || (agent === "antigravity" && !!opts.hooks);
    if (hooked)
        out.push(writeLauncher(NODE, target.cli, base, platform));
    // How a hook command starts the launcher, in a form the host's shell accepts (see hookPrefix).
    const bin = hookPrefix(launcher, platform);
    switch (agent) {
        case "claude":
            out.push(patchJson(path.join(home, ".claude", "settings.json"), (d) => [
                addHook(d, "UserPromptSubmit", { hooks: [{ type: "command", command: `${bin} claude`, timeout: 5 }] }),
                // Action triggers + skill-load logging, and the once-per-turn decision nudge.
                addHook(d, "PreToolUse", { matcher: CLAUDE_GATE_MATCHER, hooks: [{ type: "command", command: `${bin} claude gate`, timeout: 5 }] }),
                addHook(d, "PostToolUse", { matcher: CLAUDE_TOOL_MATCHER, hooks: [{ type: "command", command: `${bin} claude tool`, timeout: 5 }] }),
                addHook(d, "Stop", { hooks: [{ type: "command", command: `${bin} claude stop`, timeout: 5 }] }),
            ].join(", ")));
            out.push(patchJson(path.join(home, ".claude.json"), (d) => { (d.mcpServers ??= {}).skillrouter = { type: "stdio", ...mcpEntry(agent, d.mcpServers.skillrouter) }; return "skillrouter MCP set"; }));
            break;
        case "codex":
            out.push(patchJson(path.join(home, ".codex", "hooks.json"), (d) => [
                addHook(d, "UserPromptSubmit", { hooks: [{ type: "command", command: `${bin} codex`, timeout: 5 }] }),
                addHook(d, "PreToolUse", { matcher: CODEX_GATE_MATCHER, hooks: [{ type: "command", command: `${bin} codex gate`, timeout: 5 }] }),
                addHook(d, "PostToolUse", { matcher: CODEX_TOOL_MATCHER, hooks: [{ type: "command", command: `${bin} codex tool`, timeout: 5 }] }),
                addHook(d, "Stop", { hooks: [{ type: "command", command: `${bin} codex stop`, timeout: 5 }] }),
            ].join(", ")));
            out.push(appendToml(path.join(home, ".codex", "config.toml"), `\n[mcp_servers.skillrouter]\n${tomlMcp()}\n[mcp_servers.skillrouter.env]\nSKILLROUTER_AGENT = "codex"\n`, "[mcp_servers.skillrouter]"));
            out.push("Codex asks you to trust each new hook once (/hooks in Codex); after that the launcher keeps its command text stable across reinstalls.");
            break;
        case "cursor":
            out.push(patchJson(path.join(home, ".cursor", "hooks.json"), (d) => [
                addHook(d, "beforeSubmitPrompt", { command: `${bin} cursor` }),
                addHook(d, "preToolUse", { command: `${bin} cursor gate`, matcher: CURSOR_GATE_MATCHER, timeout: 5 }),
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
                    addHook(d, "BeforeTool", { matcher: GEMINI_GATE_MATCHER, hooks: [{ type: "command", command: `${bin} gemini gate`, timeout: 5000 }] }),
                    addHook(d, "AfterTool", { matcher: GEMINI_TOOL_MATCHER, hooks: [{ type: "command", command: `${bin} gemini tool`, timeout: 5000 }] }),
                    addHook(d, "AfterAgent", { hooks: [{ type: "command", command: `${bin} gemini stop`, timeout: 5000 }] }),
                ].join(", ");
                (d.mcpServers ??= {}).skillrouter = mcpEntry(agent, d.mcpServers.skillrouter);
                return h + " + skillrouter MCP";
            }));
            break;
        case "opencode": {
            const cfg = path.join(home, ".config", "opencode", "opencode.json");
            out.push(patchJson(cfg, (d) => { (d.mcp ??= {}).skillrouter = { ...d.mcp.skillrouter, type: "local", command: [mcpCmd().command, ...mcpCmd().args], enabled: true, environment: { ...d.mcp.skillrouter?.environment, SKILLROUTER_AGENT: agent } }; return "skillrouter MCP set"; }));
            const plugin = path.join(home, ".config", "opencode", "plugins", "skillrouter-hints.js");
            fs.mkdirSync(path.dirname(plugin), { recursive: true });
            // The plugin spawns without a shell: the POSIX launcher directly, on Windows node with the launcher module.
            fs.writeFileSync(plugin, platform === "win32" ? openCodePlugin(fwd(NODE), [fwd(launcher), "opencode"]) : openCodePlugin(launcher));
            out.push(`${plugin}: written`);
            break;
        }
        case "openclaude":
            out.push(patchJson(path.join(home, ".openclaude.json"), (d) => { (d.mcpServers ??= {}).skillrouter = { type: "stdio", ...mcpEntry(agent, d.mcpServers.skillrouter) }; return "skillrouter MCP set (no hooks on this host)"; }));
            break;
        case "antigravity": {
            const config = antigravityConfigPaths(home);
            out.push(patchJson(config.current, (d) => {
                let previous = d.mcpServers?.skillrouter;
                let migrated;
                // Never copy unrelated servers or replace a current entry with stale legacy settings.
                if (previous === undefined)
                    for (const file of config.legacy) {
                        try {
                            const entry = parseJson(fs.readFileSync(file, "utf8"))?.mcpServers?.skillrouter;
                            if (entry && typeof entry === "object" && !Array.isArray(entry)) {
                                previous = entry;
                                migrated = file;
                                break;
                            }
                        }
                        catch { /* missing/invalid legacy files aren't authoritative */ }
                    }
                (d.mcpServers ??= {}).skillrouter = mcpEntry(agent, previous);
                return `skillrouter MCP set${migrated ? `; migrated router settings from ${migrated} (legacy file retained)` : ""}`;
            }));
            out.push(opts.hooks ? installAntigravityHooks(home, bin) : "Antigravity hooks (prompt check and search gate) are available but experimental; add them with `skillrouter install antigravity --hooks`.");
            break;
        }
        case "hermes":
            out.push(...installHermes(home, bin, opts));
            break;
    }
    return out;
}
/** Hermes tools the search gate looks at: work calls, skill loads, and the router's own two tools (to see a search). */
export const HERMES_GATE_MATCHER = "^(?:terminal|write_file|patch|execute_code|skill_view|mcp_skillrouter_(?:read_skill|search_skills))$";
/** A hook entry of ours in a Hermes config: the launcher followed by `hermes`. */
// Only a command that starts with the launcher (optionally through node, as on Windows) is ours: a user's own
// script that wraps or merely mentions it is theirs and stays.
const HERMES_HOOK = /^\s*(?:\S*node(?:\.exe)?['"]?\s+)?['"]?[^'"\s]*skillrouter-hint(?:\.mjs)?['"]?\s+hermes(?:\s+gate)?\s*$/;
/**
 * What Hermes's own Python does to one HERMES_HOME (the main one or a profile): set the MCP entry, replace our hook
 * entries under `hooks:` (other hooks stay), and, when asked, record Hermes's consent for exactly those hooks in
 * shell-hooks-allowlist.json, in the format its docs give for manual allowlisting. Hermes's config API writes the
 * YAML, so comments and layout survive.
 */
const HERMES_SCRIPT = `import sys
sys.path[:] = [p for p in sys.path if p not in ("", ".")]  # never import from the folder this runs in
import json, os, re, datetime, shutil
sys.path.insert(0, sys.argv[2])
from hermes_cli.config import load_config, save_config
spec = json.loads(sys.argv[1])
def refuse(why):
    sys.stderr.write("left unchanged: " + why + "\\n")
    sys.exit(3)
c = load_config()
servers = c.get("mcp_servers")
if servers is None:
    servers = {}
    c["mcp_servers"] = servers
if not isinstance(servers, dict):
    refuse("mcp_servers is not a mapping")
prev = servers.get("skillrouter")
prev = dict(prev) if isinstance(prev, dict) else {}
env = dict(prev.get("env")) if isinstance(prev.get("env"), dict) else {}
env.update(spec["mcp"]["env"])
prev.update({"command": spec["mcp"]["command"], "args": spec["mcp"]["args"], "env": env})
servers["skillrouter"] = prev
ours = re.compile(spec["marker"])
hooks = c.get("hooks")
if hooks is None:
    hooks = {}
    c["hooks"] = hooks
if not isinstance(hooks, dict):
    refuse("hooks is not a mapping of events")
for event, entry in spec["hooks"].items():
    current = hooks.get(event)
    if current is None:
        current = []
    if not isinstance(current, list):
        refuse("hooks." + event + " is not a list")
    kept = [e for e in current if not (isinstance(e, dict) and ours.search(str(e.get("command", ""))))]
    kept.append(entry)
    hooks[event] = kept
approvals = None
path = os.path.join(os.environ["HERMES_HOME"], "shell-hooks-allowlist.json")
if spec.get("accept"):
    data = {}
    if os.path.exists(path):
        try:
            with open(path) as f:
                data = json.load(f)
        except Exception:
            refuse("shell-hooks-allowlist.json is not readable JSON; fix or remove it, then install again")
        if not isinstance(data, dict) or not isinstance(data.get("approvals", []), list):
            refuse("shell-hooks-allowlist.json has an unexpected shape")
    approvals = data.get("approvals", [])
save_config(c)
if approvals is not None:
    if os.path.exists(path) and not os.path.exists(path + ".bak-skillrouter"):
        shutil.copy2(path, path + ".bak-skillrouter")
    now = datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z")
    for event, entry in spec["hooks"].items():
        approvals = [a for a in approvals if not (isinstance(a, dict) and a.get("event") == event and a.get("command") == entry["command"])]
        approvals.append({"event": event, "command": entry["command"], "approved_at": now})
    data["approvals"] = approvals
    tmp = path + ".tmp-" + str(os.getpid())
    with open(tmp, "w") as f:
        json.dump(data, f, indent=2)
    os.replace(tmp, path)
print("ok")
`;
/**
 * Hermes: the MCP server and, through its shell hooks (config.yaml `hooks:`), the prompt check (pre_llm_call) and
 * the search gate (pre_tool_call), for the main home and every profile. Hermes runs a new hook only once the user
 * has approved it (first use in \`hermes chat\`); gateway, cron and other unattended profiles never ask, so
 * `acceptHooks` records that approval for these hooks alone. Without Hermes's Python nothing can write its YAML
 * safely: the MCP lines of profiles are still repointed (patchHermesProfiles) and the rest is named for doing by hand.
 */
function installHermes(home, bin, opts) {
    const root = path.join(home, ".hermes"), cfg = path.join(root, "config.yaml");
    const agentDir = path.join(root, "hermes-agent");
    const py = process.env.SKILLROUTER_HERMES_PYTHON || ["venv", ".venv"].flatMap((v) => [path.join(agentDir, v, "bin", "python"), path.join(agentDir, v, "Scripts", "python.exe")]).find((p) => fs.existsSync(p));
    if (!fs.existsSync(cfg))
        return [`${cfg}: missing (Hermes not installed); skipped`];
    if (!py)
        return [`${cfg}: Hermes's Python not found under ~/.hermes/hermes-agent (set SKILLROUTER_HERMES_PYTHON to it); add mcp_servers.skillrouter by hand: command ${NODE}, args [${target.cli}, "mcp"], env SKILLROUTER_AGENT=hermes${patchHermesProfiles(home)}`,
            "Hermes hooks not installed: they are written through Hermes's own config API, which needs its Python."];
    const hooks = {
        pre_llm_call: { command: `${bin} hermes`, timeout: 5 },
        pre_tool_call: { matcher: HERMES_GATE_MATCHER, command: `${bin} hermes gate`, timeout: 5 },
    };
    const spec = JSON.stringify({ mcp: { command: NODE, args: [target.cli, "mcp"], env: { SKILLROUTER_AGENT: "hermes" } }, hooks, marker: HERMES_HOOK.source, accept: !!opts.acceptHooks });
    const homes = [root];
    try {
        for (const name of fs.readdirSync(path.join(root, "profiles")).sort()) {
            const dir = path.join(root, "profiles", name);
            if (fs.existsSync(path.join(dir, "config.yaml")))
                homes.push(dir);
        }
    }
    catch { /* no profiles */ }
    const done = [], failed = [];
    for (const dir of homes) {
        const file = path.join(dir, "config.yaml"), label = dir === root ? "main" : path.basename(dir);
        try {
            backup(file, fs.statSync(file).mode & 0o777);
            const env = { ...process.env, HERMES_HOME: dir };
            // Run from Hermes's own folder, or a neutral one: never from a profile folder, whose files must not be importable.
            execFileSync(py, ["-c", HERMES_SCRIPT, spec, agentDir], { cwd: fs.existsSync(agentDir) ? agentDir : os.tmpdir(), env, stdio: ["ignore", "pipe", "pipe"], timeout: 60000, ...NO_WINDOW });
            done.push(label);
        }
        catch (e) {
            const err = e;
            failed.push(`${label} (${(String(err.stderr ?? "").trim().split("\n").pop() || err.message.split("\n")[0]).slice(0, 160)})`);
        }
    }
    const out = [`${cfg}: skillrouter MCP and hooks (prompt check, search gate) set via Hermes config API for ${done.length ? done.join(", ") : "no home"}${failed.length ? `; FAILED, not changed: ${failed.join("; ")}` : ""}`];
    // A home Hermes's API could not write still gets its MCP lines repointed where the plain layout allows.
    if (failed.length)
        out[0] += patchHermesProfiles(home);
    if (!done.length)
        return out;
    out.push(opts.acceptHooks
        ? "Hermes hooks approved for these homes (shell-hooks-allowlist.json): they run from the next session. `hermes hooks list` shows them."
        : "Hermes runs a new hook only after you approve it: `hermes chat` asks once per profile. Gateway, cron and other unattended profiles never ask; approve for all of them with `skillrouter install hermes --accept-hooks`.");
    return out;
}
/**
 * Antigravity's hooks (~/.gemini/config/hooks.json, one named group): the prompt check before a model call and the
 * search gate before a tool call. Opt-in (`install antigravity --hooks`): its docs do not say what happens when a
 * hook fails or times out, and this integration has been tested against the documented contract, not a running app.
 */
function installAntigravityHooks(home, bin) {
    return patchJson(path.join(home, ".gemini", "config", "hooks.json"), (d) => {
        const prev = d.skillrouter && typeof d.skillrouter === "object" ? d.skillrouter : {};
        d.skillrouter = {
            ...prev, enabled: prev.enabled ?? true,
            PreInvocation: [{ type: "command", command: `${bin} antigravity`, timeout: 5 }],
            // Every tool, so a search through the router's MCP tools is seen whatever name the app gives them.
            PreToolUse: [{ matcher: "", hooks: [{ type: "command", command: `${bin} antigravity gate`, timeout: 5 }] }],
        };
        return "skillrouter hooks set (PreInvocation prompt check, PreToolUse search gate); experimental, turn off with \"enabled\": false or SKILLROUTER_GATE=0";
    });
}
function appendToml(file, block, marker) {
    const cur = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const mode = cur ? fs.statSync(file).mode & 0o777 : undefined; // config.toml can hold keys: keep 0600
    if (cur)
        backup(file, mode);
    // Update only the keys owned by this installer, retaining other server settings/tables.
    let next = cur;
    for (const table of block.trim().split(/\n(?=\[)/)) {
        const [header, ...lines] = table.split("\n");
        const start = next.indexOf(header);
        if (start < 0) {
            next += `\n${table}\n`;
            continue;
        }
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
    fs.writeFileSync(`${file}.tmp-${process.pid}`, next, mode !== undefined ? { mode } : {});
    if (mode !== undefined)
        fs.chmodSync(`${file}.tmp-${process.pid}`, mode);
    renameSyncRetry(`${file}.tmp-${process.pid}`, file);
    return `${file}: updated ${marker}`;
}
/** The first install keeps the pristine copy; later installs don't overwrite it. */
function backup(file, mode) {
    const bak = `${file}.bak-skillrouter`;
    if (fs.existsSync(bak))
        return;
    fs.copyFileSync(file, bak);
    if (mode !== undefined)
        fs.chmodSync(bak, mode);
}
// Prompt hints ride on the user message they belong to and are re-applied every call, so the prompt-cache prefix
// stays stable. Trigger hints are appended to the tool result that showed the kind of work.
export function openCodePlugin(command = LAUNCHER, args = ["opencode"], timeout = 2000) {
    return `// skillrouter hints for OpenCode (installed by: npx skillrouter install opencode)
import { spawn } from 'node:child_process';
const hints = new Map();
const decided = new Set(); // turns whose decision was sent
const current = new Map(); // session -> its latest prompt (message id), so trigger checks belong to that turn
// Only tools that show the kind of work (or load a skill) start a process.
const TOOLS = /^(bash|edit|write|multiedit|patch|apply_patch|skill)$|read_skill$/;
function ask(payload, mode) {
  return new Promise((resolve) => {
    const child = spawn(${JSON.stringify(command)}, [...${JSON.stringify(args)}, ...(mode ? [mode] : [])], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
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
`;
}
/**
 * A private copy of the compiled CLI under ~/.skillrouter/app/<version>-<hash>, reached through the link
 * ~/.skillrouter/app/current. Hooks and MCP entries of every host run that copy, so a rebuild (or a half-finished
 * one) in a development checkout no longer changes what all agents execute: the copy changes only when `install`
 * runs, and then by one atomic rename of the link. Only a git checkout is copied; an installed package is used in
 * place, as is anything on Windows (no links there yet) or with SKILLROUTER_SNAPSHOT=0. Dependencies are linked, not
 * copied (the optional embedding model alone is hundreds of MB), so the checkout's node_modules must stay put;
 * `doctor` checks that. The three newest copies are kept, and older ones for two weeks.
 */
export function snapshotApp(cli = CLI, srDir = SR_DIR, platform = process.platform) {
    srDir = path.resolve(srDir);
    cli = path.resolve(cli); // configs must hold absolute paths whatever SKILLROUTER_HOME was given as
    const src = path.dirname(cli), root = path.resolve(src, "..", "..");
    const appDir = path.join(srDir, "app"), current = path.join(appDir, "current");
    const currentCli = path.join(current, "dist", "src", "cli.js");
    const real = (p) => { try {
        return fs.realpathSync(p);
    }
    catch {
        return p;
    } };
    if (platform === "win32" || process.env.SKILLROUTER_SNAPSHOT === "0")
        return { cli, note: `Code: ${cli} (used in place)` };
    if (real(src).startsWith(real(appDir) + path.sep))
        return { cli: currentCli, note: `Code: ${currentCli} (already the installed copy)` };
    if (!fs.existsSync(path.join(root, ".git")))
        return { cli, note: `Code: ${cli} (installed package, used in place)` };
    const complete = (dir) => fs.existsSync(path.join(dir, ".complete"));
    try {
        const files = fs.readdirSync(src).filter((f) => f.endsWith(".js")).sort();
        const hash = createHash("sha256");
        for (const f of files)
            hash.update(f).update(fs.readFileSync(path.join(src, f)));
        let version = "0";
        try {
            version = String(JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version);
        }
        catch { /* unnamed */ }
        const name = `${version.replace(/[^\w.-]/g, "_")}-${hash.digest("hex").slice(0, 10)}`;
        const dest = path.join(appDir, name);
        if (!complete(dest)) {
            const tmp = `${dest}.tmp-${process.pid}`;
            fs.rmSync(tmp, { recursive: true, force: true });
            fs.mkdirSync(path.join(tmp, "dist", "src"), { recursive: true, mode: 0o700 });
            for (const f of files)
                fs.copyFileSync(path.join(src, f), path.join(tmp, "dist", "src", f));
            fs.copyFileSync(path.join(root, "package.json"), path.join(tmp, "package.json"));
            for (const dir of ["node_modules", "eval"])
                if (fs.existsSync(path.join(root, dir)))
                    fs.symlinkSync(real(path.join(root, dir)), path.join(tmp, dir), "dir");
            fs.writeFileSync(path.join(tmp, ".complete"), `${new Date().toISOString()} from ${root}\n`);
            // Another install may have finished the same copy meanwhile (same code, same name): its copy is as good, and
            // `current` may already point at it, so it is never removed. Only an incomplete leftover makes way.
            try {
                if (!complete(dest)) {
                    fs.rmSync(dest, { recursive: true, force: true });
                    fs.renameSync(tmp, dest);
                }
            }
            catch (e) {
                if (!complete(dest))
                    throw e;
            }
            fs.rmSync(tmp, { recursive: true, force: true }); // ours, when the other one won
        }
        const link = `${current}.tmp-${process.pid}`;
        try {
            fs.unlinkSync(link);
        }
        catch { /* none */ }
        fs.symlinkSync(name, link, "dir");
        fs.renameSync(link, current); // atomic: a hook sees the old copy or the new one, never neither
        // Housekeeping, never fatal: leftovers of installs that died (older than an hour), and old copies beyond the three
        // newest, once two weeks old (a long-lived MCP server may still be running from one).
        try {
            const now = Date.now(), pointed = fs.readlinkSync(current);
            for (const d of fs.readdirSync(appDir)) {
                if (!/\.tmp-\d+$/.test(d))
                    continue;
                try {
                    if (now - fs.lstatSync(path.join(appDir, d)).mtimeMs > 3600e3)
                        fs.rmSync(path.join(appDir, d), { recursive: true, force: true });
                }
                catch { /* gone */ }
            }
            const old = fs.readdirSync(appDir).filter((d) => d !== "current" && d !== name && d !== pointed && complete(path.join(appDir, d)))
                .map((d) => ({ d, t: fs.statSync(path.join(appDir, d, ".complete")).mtimeMs })).sort((a, b) => b.t - a.t);
            for (const { d, t } of old.slice(2))
                if (now - t > SNAPSHOT_KEEP_MS())
                    fs.rmSync(path.join(appDir, d), { recursive: true, force: true });
        }
        catch { /* next install tidies */ }
        return { cli: currentCli, note: `Code: ${currentCli} -> ${name} (copied from ${root}; rebuilds there take effect at the next \`install\`)` };
    }
    catch (e) {
        return { cli, note: `Code: ${cli} (could not make a private copy: ${e.message.split("\n")[0]})` };
    }
}
/** How long an old copy beyond the newest three is kept (SKILLROUTER_SNAPSHOT_KEEP_DAYS, default 14). */
const SNAPSHOT_KEEP_MS = () => { const d = Number(process.env.SKILLROUTER_SNAPSHOT_KEEP_DAYS ?? 14); return (Number.isFinite(d) && d >= 0 ? d : 14) * 86400e3; };
/**
 * Hermes profiles (~/.hermes/profiles/<name>/config.yaml) each carry their own copy of the MCP entry, which the config
 * API call above does not reach. Only the two values this installer owns are rewritten: `command` and the list item
 * naming the CLI, both direct children of the `skillrouter:` entry that is itself a direct child of the top-level
 * `mcp_servers:`. The file is walked line by line (a single regex over the whole file backtracked exponentially on
 * profiles without the entry and hung `install`). A block in any other shape is left alone and named.
 */
export function hermesProfilePatch(text, node, cli) {
    const lines = text.split("\n"); // a trailing \r stays on its line and is put back untouched
    const indent = (l) => l.match(/^[ \t]*/)[0].length;
    const blank = (l) => /^[ \t]*(?:#.*)?\r?$/.test(l);
    const top = lines.findIndex((l) => /^mcp_servers:[ \t]*(?:#.*)?\r?$/.test(l));
    if (top < 0)
        return { text, state: "absent" };
    // The children of mcp_servers: everything up to the next line at column 0 that is not blank or a comment.
    let end = lines.length;
    for (let i = top + 1; i < lines.length; i++)
        if (!blank(lines[i]) && indent(lines[i]) === 0) {
            end = i;
            break;
        }
    const first = lines.slice(top + 1, end).find((l) => !blank(l));
    if (!first)
        return { text, state: "absent" };
    const child = indent(first);
    let at = -1;
    for (let i = top + 1; i < end; i++)
        if (!blank(lines[i]) && indent(lines[i]) === child && /^[ \t]*skillrouter:[ \t]*(?:#.*)?\r?$/.test(lines[i])) {
            at = i;
            break;
        }
    if (at < 0)
        return { text, state: "absent" };
    let stop = end;
    for (let i = at + 1; i < end; i++)
        if (!blank(lines[i]) && indent(lines[i]) <= child) {
            stop = i;
            break;
        }
    const body = lines.slice(at + 1, stop).map((l, k) => ({ l, i: at + 1 + k })).filter((x) => !blank(x.l));
    if (!body.length)
        return { text, state: "unrecognized" };
    const key = indent(body[0].l); // direct children of skillrouter:
    const commands = body.filter((x) => indent(x.l) === key && /^[ \t]*command:[ \t]*\S/.test(x.l));
    const argsAt = body.findIndex((x) => indent(x.l) === key && /^[ \t]*args:[ \t]*(?:#.*)?\r?$/.test(x.l));
    if (commands.length !== 1 || argsAt < 0)
        return { text, state: "unrecognized" };
    // A value that continues on the next line (a block scalar `>-`, or a long plain value the writer wrapped): rewriting
    // its first line would leave the rest behind as broken YAML.
    const continued = (i) => { for (let n = i + 1; n < stop; n++) {
        if (blank(lines[n]))
            continue;
        return indent(lines[n]) > indent(lines[i]);
    } return false; };
    if (continued(commands[0].i) || /^[ \t]*command:[ \t]*[>|]/.test(lines[commands[0].i]))
        return { text, state: "unrecognized" };
    // The items of args: the lines after it up to the next key at the block's own indent (items may sit at that indent too).
    const items = [];
    for (const x of body.slice(argsAt + 1)) {
        if (/^[ \t]*-[ \t]/.test(x.l) && indent(x.l) >= key)
            items.push(x);
        else
            break;
    }
    const value = (l) => l.replace(/^[ \t]*-[ \t]+/, "").replace(/\r$/, "").replace(/[ \t]+#.*$/, "").trim().replace(/^(["'])(.*)\1$/, "$2");
    const clis = items.filter((x) => /(?:^|[\\/])dist[\\/]src[\\/]cli\.js$/.test(value(x.l)) || /(?:^|[\\/])cli\.js$/.test(value(x.l)));
    if (clis.length !== 1 || value(items[items.length - 1]?.l ?? "") !== "mcp")
        return { text, state: "unrecognized" };
    if (continued(clis[0].i) || /^[ \t]*-[ \t]+[>|]/.test(lines[clis[0].i]))
        return { text, state: "unrecognized" };
    const before = [lines[commands[0].i], lines[clis[0].i]];
    // A line's own ending (\r of a CRLF file) is set aside and put back: `.` does not match it.
    const set = (i, pattern, v) => { const cr = lines[i].endsWith("\r") ? "\r" : ""; lines[i] = lines[i].slice(0, lines[i].length - cr.length).replace(pattern, (_m, lead) => `${lead}${JSON.stringify(v)}`) + cr; };
    set(commands[0].i, /^([ \t]*command:[ \t]*).*$/, node);
    set(clis[0].i, /^([ \t]*-[ \t]+).*$/, cli);
    const changed = lines[commands[0].i] !== before[0] || lines[clis[0].i] !== before[1];
    return { text: lines.join("\n"), state: changed ? "patched" : "current" };
}
export function patchHermesProfiles(home) {
    const dir = path.join(home, ".hermes", "profiles");
    let names = [];
    try {
        names = fs.readdirSync(dir).sort();
    }
    catch {
        return "";
    }
    let done = 0;
    const left = [];
    for (const name of names) {
        const file = path.join(dir, name, "config.yaml");
        let text;
        try {
            text = fs.readFileSync(file, "utf8");
        }
        catch {
            continue;
        }
        const result = hermesProfilePatch(text, NODE, target.cli);
        if (result.state === "absent")
            continue;
        if (result.state === "unrecognized") {
            left.push(name);
            continue;
        }
        done++;
        if (result.state === "current")
            continue;
        const mode = fs.statSync(file).mode & 0o777;
        backup(file, mode);
        const tmp = `${file}.tmp-${process.pid}`;
        fs.writeFileSync(tmp, result.text, { mode });
        fs.chmodSync(tmp, mode);
        renameSyncRetry(tmp, file);
    }
    return done || left.length ? `; ${done} profile${done === 1 ? "" : "s"} pointed at the same Node and code${left.length ? `, left as found (unrecognized layout): ${left.join(", ")}` : ""}` : "";
}
