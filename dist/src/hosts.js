import { createHash } from "node:crypto";
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
export function fromHost(agent, input, gate) {
    if (agent !== "hermes" && agent !== "antigravity")
        return input;
    let p;
    try {
        p = JSON.parse(input);
    }
    catch {
        return input;
    }
    if (!p || typeof p !== "object" || Array.isArray(p))
        return input;
    if (agent === "hermes") {
        if (typeof p.hook_event_name !== "string")
            return input;
        const extra = p.extra && typeof p.extra === "object" ? p.extra : {};
        const base = { session_id: str(p.session_id), prompt_id: str(extra.turn_id), cwd: str(p.cwd) };
        if (!gate)
            return JSON.stringify({ ...base, prompt: textOf(extra.user_message) });
        const tool = hermesTool(str(p.tool_name) ?? "", p.tool_input);
        return JSON.stringify({ ...base, tool_use_id: str(extra.tool_call_id), ...tool });
    }
    if (typeof p.conversationId !== "string")
        return input;
    const session = sha(p.conversationId), prompt = typeof p.lastUserInput === "string" ? p.lastUserInput : "";
    const base = { session_id: p.conversationId, cwd: Array.isArray(p.workspacePaths) ? str(p.workspacePaths[0]) : undefined };
    if (!gate) {
        const turn = hostTurn(session, sha(prompt), true);
        if (!turn || !turn.fresh)
            return null; // a later model call of the turn already checked
        return JSON.stringify({ ...base, prompt_id: turn.turn, prompt });
    }
    // The turn the prompt check opened for this same user input. Without one for this input, the gate goes by the
    // conversation's latest turn, as on hosts that send no turn id.
    const turn = hostTurn(session, sha(prompt), false);
    const call = p.toolCall && typeof p.toolCall === "object" ? p.toolCall : {};
    return JSON.stringify({ ...base, prompt_id: turn?.turn, tool_use_id: typeof p.stepIdx === "number" ? `step-${p.stepIdx}` : undefined, ...antigravityTool(str(call.name) ?? "", call.args) });
}
const sha = (s) => createHash("sha256").update(s).digest("hex");
const str = (v) => (typeof v === "string" && v ? v : undefined);
const obj = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
/** A user message as text: a string, or the text parts of a multimodal message. */
function textOf(message) {
    if (typeof message === "string")
        return message;
    if (Array.isArray(message))
        return message.map((part) => (part && typeof part === "object" && typeof part.text === "string" ? part.text : "")).filter(Boolean).join("\n");
    return "";
}
/** The router's own MCP tools under either host's naming, as the names the gate and load detection know. */
function routerTool(name, args) {
    // mcp_skillrouter_search_skills, mcp__skillrouter__read_skill, skillrouter/search_skills, SkillRouter.searchSkills …:
    // the server's name, then the tool's. Also a bare or merely mcp-prefixed tool name (mcp0_search_skills), for hosts
    // that drop the server from it; another server's tool (mcp_other_search_skills) is not the router's.
    const tool = (t) => (/^search_?skills$/i.test(t) ? "search_skills" : /^read_?skill$/i.test(t) ? "read_skill" : null);
    const m = name.match(/(?:^|[_.:/-])skill_?router[_.:/-]*([A-Za-z_]+)$/i) ?? name.match(/^(?:mcp\d*[_.:/-]+)?((?:search_?skills|read_?skill))$/i);
    const which = m ? tool(m[1]) : null;
    return which ? { tool_name: `mcp__skillrouter__${which}`, tool_input: obj(args) } : null;
}
function hermesTool(name, raw) {
    const a = obj(raw);
    const router = routerTool(name, a);
    if (router)
        return router;
    switch (name) {
        case "terminal": return { tool_name: "Bash", tool_input: { command: a.command } };
        case "write_file": return { tool_name: "Write", tool_input: { file_path: a.path } };
        // A replace-mode patch names its file; a V4A patch (mode "patch") names its files inside the text, which the patch parser reads.
        case "patch": return typeof a.path === "string" && a.path ? { tool_name: "Edit", tool_input: { file_path: a.path } } : { tool_name: "apply_patch", tool_input: { patch: a.patch } };
        // Code run in Hermes's sandbox changes things as a script would: it is work, like a command that runs a script.
        case "execute_code": return { tool_name: "Bash", tool_input: { command: "python3 hermes_execute_code.py" } };
        case "read_file": return { tool_name: "Read", tool_input: { file_path: a.path } };
        case "skill_view": return { tool_name: "Skill", tool_input: { skill: a.name } };
        default: return { tool_name: name, tool_input: a };
    }
}
function antigravityTool(name, raw) {
    const a = obj(raw);
    const router = routerTool(name, a);
    if (router)
        return router;
    switch (name) {
        case "run_command": return { tool_name: "Bash", tool_input: { command: a.CommandLine } };
        case "write_to_file": return { tool_name: "Write", tool_input: { file_path: a.TargetFile } };
        case "replace_file_content":
        case "multi_replace_file_content": return { tool_name: "Edit", tool_input: { file_path: a.TargetFile } };
        case "view_file": return { tool_name: "Read", tool_input: { file_path: a.AbsolutePath } };
        default: return { tool_name: name, tool_input: a };
    }
}
/** What a hook prints when it has nothing to say. Antigravity's PreToolUse requires a decision; the others accept silence. */
export function silent(agent, gate) {
    return agent === "antigravity" ? (gate ? JSON.stringify({ decision: "allow" }) : "{}") : agent === "hermes" ? "{}" : "";
}
