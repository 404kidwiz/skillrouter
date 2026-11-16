import { logUsage } from "./search.js";
import type { HookAgent } from "./paths.js";
import { fromHost, silent } from "./hosts.js";
import { sessionHash, sessionOf, turnOf } from "./hint.js";
import { actionOf, isWork, shellCommand } from "./triggers.js";
import { skillLoadOf } from "./events.js";
import { addLoaded, addSearched, claim, claimDenial, claimed, gateProgress, gatedTurn, loadedSkills, sessionSearched, turnSeen } from "./state.js";
import { creditRequest, knownSkill } from "./recurring.js";

/**
 * The search gate: the rule "search the skill library before you start work" as something the agent cannot skip.
 *
 * On a turn whose prompt describes a task (the prompt check marks it, see hint.ts), the first work tool call (an edit, or a
 * command that does more than read) is refused until the agent has called search_skills or loaded a skill in that turn. The
 * refusal names what to do, so the agent's next call is the search. After two refusals in a turn the gate steps aside, so an
 * agent that cannot search (the router is down, a skill is unreadable) is never stuck; both refusals say so, the second that it is the last. Subagents (on hosts that mark them: a Hermes
 * child has a session of its own and is judged by its own brief) and reads are never gated;
 * a short or conversational prompt ("continue", "go ahead") is gated only while the session has not searched at all, because it
 * carries on earlier work; SKILLROUTER_GATE=0 turns it off.
 *
 * Cursor's CLI (cursor-agent) sends tool events but never the prompt, so no turn there can be marked as a task. In such a
 * session the gate asks once: the first work call is refused until the session has searched or loaded a skill, with the same
 * two-refusal limit, counted for the whole session because there are no turns to count by.
 *
 * Measured on this machine before the gate, over a week: Claude Code made 0 searches and Codex 33, with the same written rule.
 */
export const GATE_MAX_DENIALS = 2;
export const gateEnabled = () => process.env.SKILLROUTER_GATE !== "0";

// An agent that cannot search must be told how the call gets through. Seen on a Mac, 2026-11-11 to 15: an hourly Codex
// automation ran in a thread without the router's tools, read the refusal as a hard stop, and skipped its work 88 times.
const CANNOT_SEARCH = " If search_skills is not available in this session, say so and repeat this same call: it is refused twice at most, then let through.";
export const GATE_REASON = "skillrouter: before starting this work, search the skill library once: call search_skills with a short phrase for the task " +
  "(or read_skill for a skill the Skill check above suggested), read what fits, then carry on with this same call. " +
  "If nothing fits, say so on your `Skills:` line afterwards. This stops only the first work call of a task turn." + CANNOT_SEARCH;
/** The same request where no prompt was seen: there was no Skill check to refer to, and it is asked once per session. */
export const GATE_REASON_NO_PROMPT = "skillrouter: before starting this work, search the skill library once: call search_skills with a short phrase for the task, " +
  "read what fits, then carry on with this same call. If nothing fits, say so on your `Skills:` line afterwards. This stops only the first work call of this session." + CANNOT_SEARCH;
/** The final refusal: the next attempt is let through, and the agent is told so instead of being left to guess. */
export const GATE_REASON_LAST = "skillrouter: no search of the skill library was seen. This is the last refusal: repeat this same call and it will go through. " +
  "Call search_skills first if you can; if it is not available in this session, say so on your `Skills:` line.";

/** The host's own way of saying "not this call, and here is why". */
export function formatGate(agent: HookAgent, reason = GATE_REASON): string {
  switch (agent) {
    case "hermes": return JSON.stringify({ decision: "block", reason });
    case "antigravity": return JSON.stringify({ decision: "deny", reason });
    case "gemini": return JSON.stringify({ decision: "deny", reason });
    case "cursor": return JSON.stringify({ permission: "deny", user_message: "skillrouter: searching the skill library first.", agent_message: reason });
    default: return JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } });
  }
}

/** A pre-tool payload as a work action: the host's tool name and input, or (Cursor's shell hook) a bare command. */
function actionFor(p: any) {
  if (typeof p?.tool_name === "string") return actionOf(p.tool_name, p?.tool_input);
  if (typeof p?.command === "string") { const c = shellCommand({ command: p.command }); return c ? { command: c } : null; }
  return null;
}

/** The router's search_skills under the host namings (mcp__skillrouter__…, mcp__plugin_…skillrouter__…, mcp_skillrouter_…, skillrouter_…, MCP:…); another server's tool of that name is not it. */
export const ROUTER_SEARCH = /^(?:mcp__(?:plugin_[\w.-]+_)?skillrouter__|mcp_skillrouter_|skillrouter_{1,2}|MCP:)search_skills$/;

/**
 * A search or a skill load, seen by the gate itself. The post-tool hook would see it too, but Codex asks the user to trust
 * each hook entry and never runs one that is not trusted yet, so the gate does not wait on another hook to learn that the
 * agent has done what it asks. Loads use the same detector as the post-tool hook (skillLoadOf), so `echo "cat x/SKILL.md"`
 * or writing a SKILL.md is not one.
 */
function lookupOf(p: any): "search" | "load" | null {
  const tool = typeof p?.tool_name === "string" ? p.tool_name : "";
  if (ROUTER_SEARCH.test(tool)) return "search";
  return skillLoadOf(tool, p?.tool_input) !== null ? "load" : null;
}

/**
 * The hook's answer for one pre-tool event: a host-shaped denial, or "" to let the call through. Never throws.
 * `enabled` is the hook's own SKILLROUTER_GATE: the warm service runs this on behalf of many hooks and must not read its own.
 */
export function gateEvent(agent: HookAgent, input: string, enabled = gateEnabled()): string {
  // A host that requires an answer (Antigravity: a decision on every call) gets its "go ahead" where others get silence.
  return gateDecision(agent, input, enabled) || silent(agent, true);
}

function gateDecision(agent: HookAgent, rawInput: string, enabled: boolean): string {
  try {
    if (!enabled) return "";
    const input = fromHost(agent, rawInput, "gate");
    if (input === null) return "";
    const p = JSON.parse(input);
    if (!p || typeof p !== "object" || p.agent_id) return ""; // a subagent works from its own brief
    const session = sessionHash(sessionOf(p));
    if (!session) return "";
    const turn = sessionHash(turnOf(p));
    // A tool event in a session whose prompt was never seen: the host ran this hook but not the prompt hook (Cursor's CLI
    // sends no beforeSubmitPrompt; a Codex prompt hook not yet trusted). The gate cannot arm without a prompt, so nothing
    // else would be logged and doctor would read the host as silent. One row per session says what did happen.
    // (Per host: Cursor's CLI also runs Claude Code's hooks from ~/.claude/settings.json on the same session id, and that
    // copy would otherwise take the session's one row and label it "claude".)
    if (!turnSeen(session) && claim(session, `no-prompt-event-${agent}`)) logUsage({ client: `hook/${agent}`, agent, tool: "gate", reason: "no_prompt_event", session });
    const lookup = lookupOf(p);
    if (lookup) {
      addSearched(session, turn, undefined, lookup);
      if (lookup === "load") {
        const load = skillLoadOf(typeof p.tool_name === "string" ? p.tool_name : "", p.tool_input);
        // This is seen before the call runs, so it may yet fail: only a name that is exactly one indexed skill counts.
        const known = load ? knownSkill(load.skill) : undefined;
        if (load && known) {
          creditRequest(session, known); // what this request used, for its next run (recurring.ts)
          // Hermes and Antigravity have no after-tool hook: the gate is where their skill loads are seen and logged (once per call).
          if ((agent === "hermes" || agent === "antigravity") && claim(session, `gate-load-${String(p.tool_use_id ?? known).slice(0, 80)}`)) {
            addLoaded(session, known); logUsage({ client: `hook/${agent}`, agent, tool: "skill_load", via: load.via, skill: known, session, prompt: turn });
          }
        }
      }
      return "";
    }
    if (!isWork(actionFor(p))) return "";
    const log = (reason: string) => logUsage({ client: `hook/${agent}`, agent, tool: "gate", reason, session, prompt: turn });
    const refuse = (key: string, reason?: string) => {
      const slot = claimDenial(session, key, GATE_MAX_DENIALS);
      // The last slot being taken means no further refusal follows (two calls at once may both say so; each is then let through).
      if (slot === "denied") { log("denied"); return formatGate(agent, claimed(session, `deny-${key}-${GATE_MAX_DENIALS}`) ? GATE_REASON_LAST : reason); }
      if (slot === "stepped_aside") log("stepped_aside");
      return "";
    };
    const gated = gatedTurn(session, turn);
    if (!gated) {
      // No prompt was ever seen here, so no turn could be marked as a task. Only for Cursor: its CLI is the one host known
      // to run tool hooks without the prompt hook, and its editor always sends the prompt first, so it never reaches this.
      // Not for every host: the CLI also runs Claude Code's hooks on the same session (a second refusal for one call), and
      // a host whose subagents arrive as unmarked sessions of their own would have each of them stopped.
      if (agent !== "cursor" || turnSeen(session) || sessionSearched(session)) return "";
      return refuse("no-prompt", GATE_REASON_NO_PROMPT);
    }
    if (gateProgress(session, gated.start, turn).searched || loadedSkills(session, undefined, gated.start).size) return "";
    return refuse(String(turn ?? gated.start));
  } catch { return ""; }
}
