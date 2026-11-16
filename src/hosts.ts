import { createHash } from "node:crypto";
import type { HookAgent } from "./paths.js";
import { hostTurn } from "./state.js";

/**
 * Hermes and Antigravity send hook payloads in their own shapes and tool vocabularies. Each is rewritten here into
 * the shape the prompt check and the search gate already understand (session_id, prompt_id, prompt, tool_name,
 * tool_input with Claude Code's tool names), so nothing downstream needs to know the host. The answers are shaped
 * back in formatHint (hint.ts) and formatGate (gate.ts).
 *
 * Hermes (shell hooks in config.yaml, docs: user-guide/features/hooks.md, "Shell Hooks"):
 *   stdin  { hook_event_name, tool_name, tool_input, session_id, cwd, profile, extra: { user_message, turn_id, tool_call_id, … } }
 *   events pre_llm_call (once per user turn; answer { context }) and pre_tool_call (answer { decision: "block", reason })
 *   tools  terminal{command} write_file{path} patch{path} read_file{path} skill_view{name} mcp_<server>_<tool>
 *
 * Antigravity (hooks.json, docs: antigravity.google/docs/hooks):
 *   stdin  { conversationId, workspacePaths, lastUserInput, … } plus toolCall{ name, args } on PreToolUse
 *   events PreInvocation (before every model call, so several per user turn; answer { injectSteps }) and
 *          PreToolUse (answer { decision: "allow" | "deny", reason }; a decision is required)
 *   tools  run_command{CommandLine} write_to_file{TargetFile} replace_file_content{TargetFile} view_file{AbsolutePath}
 *   There is no turn id: a turn is a change of lastUserInput within the conversation (hostTurn keeps the last one).
 *
 * Returns the rewritten JSON, the input itself when it is not in the host's shape (already generic: tests, probes),
 * or null when there is nothing to do for this event (Antigravity's second and later model calls of a turn).
 */
export function fromHost(agent: HookAgent, input: string, gate: boolean): string | null {
  if (agent !== "hermes" && agent !== "antigravity") return input;
  let p: any;
  try { p = JSON.parse(input); } catch { return input; }
  if (!p || typeof p !== "object" || Array.isArray(p)) return input;
  if (agent === "hermes") {
    if (typeof p.hook_event_name !== "string") return input;
    const extra = p.extra && typeof p.extra === "object" ? p.extra : {};
    const base = { session_id: str(p.session_id), prompt_id: str(extra.turn_id), cwd: str(p.cwd) };
    if (!gate) return JSON.stringify({ ...base, prompt: textOf(extra.user_message) });
    const tool = hermesTool(str(p.tool_name) ?? "", p.tool_input);
    return JSON.stringify({ ...base, tool_use_id: str(extra.tool_call_id), ...tool });
  }
  if (typeof p.conversationId !== "string") return input;
  const session = sha(p.conversationId), prompt = typeof p.lastUserInput === "string" ? p.lastUserInput : "";
  const base = { session_id: p.conversationId, cwd: Array.isArray(p.workspacePaths) ? str(p.workspacePaths[0]) : undefined };
  if (!gate) {
    const turn = hostTurn(session, sha(prompt), true);
    if (!turn || !turn.fresh) return null; // a later model call of the turn already checked
    return JSON.stringify({ ...base, prompt_id: turn.turn, prompt });
  }
  // The turn the prompt check opened for this same user input; without one (the check never ran) there is no task to gate.
  const turn = hostTurn(session, sha(prompt), false);
  const call = p.toolCall && typeof p.toolCall === "object" ? p.toolCall : {};
  return JSON.stringify({ ...base, prompt_id: turn?.turn, tool_use_id: typeof p.stepIdx === "number" ? `step-${p.stepIdx}` : undefined, ...antigravityTool(str(call.name) ?? "", call.args) });
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** A user message as text: a string, or the text parts of a multimodal message. */
function textOf(message: unknown): string {
  if (typeof message === "string") return message;
  if (Array.isArray(message)) return message.map((part) => (part && typeof part === "object" && typeof (part as any).text === "string" ? (part as any).text : "")).filter(Boolean).join("\n");
  return "";
}

/** The router's own MCP tools under either host's naming, as the names the gate and load detection know. */
function routerTool(name: string, args: unknown): { tool_name: string; tool_input: unknown } | null {
  const m = name.match(/(?:^|[_.:/-])skillrouter[_.:/-]+(search_skills|read_skill)$/) ?? (/^(search_skills|read_skill)$/.test(name) ? [name, name] : null);
  return m ? { tool_name: `mcp__skillrouter__${m[1]}`, tool_input: obj(args) } : null;
}

function hermesTool(name: string, raw: unknown): { tool_name: string; tool_input: unknown } {
  const a = obj(raw);
  const router = routerTool(name, a);
  if (router) return router;
  switch (name) {
    case "terminal": return { tool_name: "Bash", tool_input: { command: a.command } };
    case "write_file": return { tool_name: "Write", tool_input: { file_path: a.path } };
    case "patch": return { tool_name: "Edit", tool_input: { file_path: a.path } }; // a V4A patch without a path names its files inside; it still counts as an edit when a path is given
    case "read_file": return { tool_name: "Read", tool_input: { file_path: a.path } };
    case "skill_view": return { tool_name: "Skill", tool_input: { skill: a.name } };
    default: return { tool_name: name, tool_input: a };
  }
}

function antigravityTool(name: string, raw: unknown): { tool_name: string; tool_input: unknown } {
  const a = obj(raw);
  const router = routerTool(name, a);
  if (router) return router;
  switch (name) {
    case "run_command": return { tool_name: "Bash", tool_input: { command: a.CommandLine } };
    case "write_to_file": return { tool_name: "Write", tool_input: { file_path: a.TargetFile } };
    case "replace_file_content": case "multi_replace_file_content": return { tool_name: "Edit", tool_input: { file_path: a.TargetFile } };
    case "view_file": return { tool_name: "Read", tool_input: { file_path: a.AbsolutePath } };
    default: return { tool_name: name, tool_input: a };
  }
}

/** What a hook prints when it has nothing to say. Antigravity's PreToolUse requires a decision; the others accept silence. */
export function silent(agent: HookAgent, gate: boolean): string {
  return agent === "antigravity" ? (gate ? JSON.stringify({ decision: "allow" }) : "{}") : agent === "hermes" ? "{}" : "";
}
