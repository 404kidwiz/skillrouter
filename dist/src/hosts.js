import { createHash } from "node:crypto";
import fs from "node:fs";
import { hostTurn } from "./state.js";
export function fromHost(agent, input, mode) {
    const gate = mode === "gate";
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
        // post_llm_call: the turn's final reply, read for its `Skills:` line (what was decided about the skill check).
        if (mode === "decision")
            return JSON.stringify({ ...base, text: typeof extra.assistant_response === "string" ? extra.assistant_response : "" });
        if (!gate)
            return JSON.stringify({ ...base, prompt: textOf(extra.user_message) });
        const tool = hermesTool(str(p.tool_name) ?? "", p.tool_input);
        return JSON.stringify({ ...base, tool_use_id: str(extra.tool_call_id), ...tool });
    }
    if (typeof p.conversationId !== "string")
        return input;
    const session = sha(p.conversationId), prompt = typeof p.lastUserInput === "string" ? p.lastUserInput : "";
    if (mode === "decision") {
        // Stop hook: read the turn's PLANNER_RESPONSE text from the transcript for verdict recording only (never blocks Stop).
        const turn = hostTurn(session, sha(prompt), false);
        const text = antigravityReplyText(str(p.transcriptPath) ?? str(p.transcript_path) ?? "");
        if (!turn || !text)
            return null;
        return JSON.stringify({ session_id: p.conversationId, prompt_id: turn.turn, text });
    }
    const subagent = str(p.agentId) ?? str(p.agent_id) ?? str(p.subagentId) ?? str(p.subagent_id) ??
        (str(p.parentConversationId) || str(p.parent_conversation_id) || p.isSubagent === true || p.is_subagent === true ? p.conversationId : undefined);
    const base = {
        session_id: p.conversationId,
        cwd: Array.isArray(p.workspacePaths) ? str(p.workspacePaths[0]) : undefined,
        ...(subagent ? { agent_id: subagent } : {}),
    };
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
/** Read the bounded tail of an Antigravity JSONL transcript and return PLANNER_RESPONSE text(s) after the last USER_INPUT. */
function antigravityReplyText(transcriptPath, maxBytes = 2 * 1024 * 1024) {
    if (!transcriptPath)
        return "";
    let fd;
    let lines = [];
    try {
        fd = fs.openSync(transcriptPath, "r");
        const size = fs.fstatSync(fd).size;
        if (size <= 0)
            return "";
        const start = Math.max(0, size - maxBytes);
        const buf = Buffer.alloc(size - start);
        fs.readSync(fd, buf, 0, buf.length, start);
        lines = buf.toString("utf8").split("\n");
        if (start > 0)
            lines.shift(); // first line may be cut mid-record
    }
    catch {
        return "";
    }
    finally {
        if (fd !== undefined)
            fs.closeSync(fd);
    }
    const records = [];
    for (const line of lines) {
        if (!line.trim())
            continue;
        try {
            records.push(JSON.parse(line));
        }
        catch { /* skip malformed line */ }
    }
    if (!records.length)
        return "";
    let lastUser = -1;
    for (let i = records.length - 1; i >= 0; i--) {
        if (records[i]?.type === "USER_INPUT") {
            lastUser = i;
            break;
        }
    }
    const slice = lastUser >= 0 ? records.slice(lastUser + 1) : records;
    const texts = [];
    for (const r of slice) {
        if (r?.type === "PLANNER_RESPONSE" && typeof r.content === "string" && r.content.trim())
            texts.push(r.content.trim());
    }
    return texts.join("\n");
}
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
    if (name === "call_mcp_tool") {
        const server = str(a.ServerName) ?? str(a.serverName) ?? str(a.server_name) ?? str(a.server) ?? "";
        const toolName = str(a.ToolName) ?? str(a.toolName) ?? str(a.tool_name) ?? str(a.tool) ?? "";
        if (/^skill_?router$/i.test(server) && toolName) {
            let wrappedArgs = a.Arguments ?? a.arguments ?? a.args;
            if (typeof wrappedArgs === "string") {
                try {
                    wrappedArgs = JSON.parse(wrappedArgs);
                }
                catch { /* keep raw */ }
            }
            const wrapped = routerTool(`skillrouter_${toolName}`, wrappedArgs);
            if (wrapped)
                return wrapped;
        }
    }
    switch (name) {
        case "run_command": return { tool_name: "Bash", tool_input: { command: a.CommandLine ?? a.command_line ?? a.command } };
        case "write_to_file":
        case "write_file": return { tool_name: "Write", tool_input: { file_path: a.Path ?? a.TargetFile ?? a.path ?? a.target_file } };
        case "replace_file_content":
        case "multi_replace_file_content":
        case "edit_file": return { tool_name: "Edit", tool_input: { file_path: a.Path ?? a.TargetFile ?? a.path ?? a.target_file } };
        case "view_file":
        case "read_file": return { tool_name: "Read", tool_input: { file_path: a.Path ?? a.AbsolutePath ?? a.path ?? a.absolute_path } };
        default: return { tool_name: name, tool_input: a };
    }
}
/** What a hook prints when it has nothing to say. Antigravity's PreToolUse requires a decision; the others accept silence. */
export function silent(agent, gate) {
    return agent === "antigravity" ? (gate ? JSON.stringify({ decision: "allow" }) : "{}") : agent === "hermes" ? "{}" : "";
}
