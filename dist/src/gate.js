import { logUsage } from "./search.js";
import { sessionHash, sessionOf, turnOf } from "./hint.js";
import { actionOf, isWork, shellCommand } from "./triggers.js";
import { addDenied, gateProgress, gatedTurn, loadedSkills } from "./state.js";
/**
 * The search gate: the rule "search the skill library before you start work" as something the agent cannot skip.
 *
 * On a turn whose prompt describes a task (the prompt check marks it, see hint.ts), the first work tool call (an edit, or a
 * command that does more than read) is refused until the agent has called search_skills or loaded a skill in that turn. The
 * refusal names what to do, so the agent's next call is the search. After two refusals in a turn the gate steps aside, so an
 * agent that cannot search (the router is down, a skill is unreadable) is never stuck. Subagents, reads, searches and
 * conversational turns are never gated; SKILLROUTER_GATE=0 turns it off.
 *
 * Measured on this machine before the gate, over a week: Claude Code made 0 searches and Codex 33, with the same written rule.
 */
export const GATE_MAX_DENIALS = 2;
export const gateEnabled = () => process.env.SKILLROUTER_GATE !== "0";
export const GATE_REASON = "skillrouter: before starting this work, search the skill library once: call search_skills with a short phrase for the task " +
    "(or read_skill for a skill the Skill check above suggested), read what fits, then carry on with this same call. " +
    "If nothing fits, say so on your `Skills:` line afterwards. This stops only the first work call of a task turn.";
/** The host's own way of saying "not this call, and here is why". */
export function formatGate(agent, reason = GATE_REASON) {
    switch (agent) {
        case "gemini": return JSON.stringify({ decision: "deny", reason });
        case "cursor": return JSON.stringify({ permission: "deny", user_message: "skillrouter: searching the skill library first.", agent_message: reason });
        default: return JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } });
    }
}
/** A pre-tool payload as a work action: the host's tool name and input, or (Cursor's shell hook) a bare command. */
function actionFor(p) {
    if (typeof p?.tool_name === "string")
        return actionOf(p.tool_name, p?.tool_input);
    if (typeof p?.command === "string") {
        const c = shellCommand({ command: p.command });
        return c ? { command: c } : null;
    }
    return null;
}
/** The hook's answer for one pre-tool event: a host-shaped denial, or "" to let the call through. Never throws. */
export function gateEvent(agent, input) {
    try {
        if (!gateEnabled())
            return "";
        const p = JSON.parse(input);
        if (!p || typeof p !== "object" || p.agent_id)
            return ""; // a subagent works from its own brief
        if (!isWork(actionFor(p)))
            return "";
        const session = sessionHash(sessionOf(p));
        if (!session)
            return "";
        const turn = sessionHash(turnOf(p));
        const gated = gatedTurn(session, turn);
        if (!gated)
            return "";
        const { searched, denied } = gateProgress(session, gated.start, turn);
        if (searched || loadedSkills(session, undefined, gated.start).size)
            return "";
        const log = (reason) => logUsage({ client: `hook/${agent}`, agent, tool: "gate", reason, session, prompt: turn });
        if (denied >= GATE_MAX_DENIALS) {
            if (denied === GATE_MAX_DENIALS) {
                addDenied(session, turn);
                log("stepped_aside");
            }
            return "";
        }
        addDenied(session, turn);
        log("denied");
        return formatGate(agent);
    }
    catch {
        return "";
    }
}
