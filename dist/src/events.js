import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { INDEX_FILE } from "./paths.js";
import { getIndex, logUsage, search } from "./search.js";
import { readCore } from "./core.js";
import { semanticScores } from "./embed.js";
import { formatHint, hintText, sessionHash } from "./hint.js";
import { actionOf, matchTriggers } from "./triggers.js";
import { addLoaded, addShown, bareSkill, claim, loadedSkills, shownFor } from "./state.js";
/** The last `bytes` of a file as lines (the usage log and transcripts only grow; hooks read their tails). */
export function tailLines(file, bytes = 512 * 1024) {
    let fd;
    try {
        fd = fs.openSync(file, "r");
        const size = fs.fstatSync(fd).size;
        const start = Math.max(0, size - bytes);
        const buf = Buffer.alloc(size - start);
        fs.readSync(fd, buf, 0, buf.length, start);
        const lines = buf.toString("utf8").split("\n");
        if (start > 0)
            lines.shift(); // first line is cut
        return lines.filter(Boolean);
    }
    catch {
        return [];
    }
    finally {
        if (fd !== undefined)
            fs.closeSync(fd);
    }
}
/** A file path relative to the session's working directory, so folders above the repo (…/auth-service/…) don't trigger rules. */
function relativeAction(action, cwd) {
    if (!action.file || typeof cwd !== "string" || !cwd)
        return action;
    const rel = path.relative(cwd, action.file);
    return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? { ...action, file: rel } : action;
}
/**
 * PostToolUse: record loads of skills (native Skill tool, router read_skill) so hints are credited
 * and not repeated; and fire an action trigger, once per session per rule and per agent (subagents
 * have their own `agent_id`), when the tool call shows what kind of work this is. The rule is claimed
 * atomically before searching, so parallel tool calls cannot fire it twice. Cheap path first.
 */
export async function toolEvent(agent, input, inWorker) {
    let p;
    try {
        p = JSON.parse(input);
    }
    catch {
        return "";
    }
    const tool = String(p?.tool_name ?? "");
    const session = sessionHash(p?.session_id);
    const sub = sessionHash(p?.agent_id);
    if (tool === "Skill" || /skillrouter__read_skill$/.test(tool)) {
        const skill = String(p?.tool_input?.skill ?? p?.tool_input?.id ?? "");
        if (skill && !inWorker) {
            addLoaded(session, skill, sub);
            logUsage({ client: `hook/${agent}`, agent, tool: "skill_load", via: tool === "Skill" ? "Skill" : "read_skill",
                skill, hint_id: p?.tool_input?.hint_id, session, sub, prompt: sessionHash(p?.prompt_id) });
        }
        return "";
    }
    if (inWorker) {
        const claimed = Array.isArray(p?._claimed) ? p._claimed : [];
        const action = actionOf(tool, p?.tool_input);
        if (!action || !claimed.length)
            return "";
        return triggerHints(agent, relativeAction(action, p?.cwd), claimed, session, sub, sessionHash(p?.prompt_id));
    }
    const action = actionOf(tool, p?.tool_input);
    // No session (nothing to dedupe against) or no index (nothing to suggest): never claim, never fire.
    if (!action || !session || !fs.existsSync(INDEX_FILE))
        return "";
    // At most two rules per call, and only those two are claimed, so no rule is used up without being shown.
    const matches = matchTriggers(relativeAction(action, p?.cwd)).slice(0, 2);
    const claimed = matches.filter((m) => claim(session, `${m.trigger.id}${sub ? "-" + sub.slice(0, 12) : ""}`)).map((m) => m.trigger.id);
    if (!claimed.length)
        return "";
    // Searching (and maybe loading the model) runs in a killable worker; it gets the claimed rules, not the tool output.
    return { spawn: JSON.stringify({ ...p, _claimed: claimed, tool_response: undefined }) };
}
async function triggerHints(agent, action, claimed, session, sub, prompt) {
    const loaded = loadedSkills(session, sub);
    const blocks = [];
    const hint_id = randomUUID();
    const { index } = getIndex();
    // One semantic budget for the whole call: the worker must answer well inside its 1.5 s deadline.
    const deadline = performance.now() + 900;
    let semanticDown = false;
    for (const m of matchTriggers(action).filter((m) => claimed.includes(m.trigger.id)).slice(0, 2)) {
        const budget = deadline - performance.now();
        const sem = semanticDown || budget < 100 ? { scores: null, status: "timeout" } : await semanticScores(m.query, budget, index.builtAt);
        if (sem.status === "timeout")
            semanticDown = true;
        const hits = triggerPicks(await search(m.query, 10, { semantic: sem.scores }), loaded);
        logUsage({ client: `hook/${agent}`, agent, tool: "trigger", trigger: m.trigger.id, hint_id, session, sub, prompt, sem: sem.status,
            reason: hits.length ? "shown" : "no_match", hits: hits.map((h) => [h.skill.id, h.score, h.raw, h.cos ?? null]) });
        if (!hits.length)
            continue;
        if (!sub)
            addShown(session, hits.map((h) => h.skill.id), prompt);
        blocks.push(hintText(hits, hint_id, new Set(readCore()), agent, `Skill check (skillrouter): you ${m.trigger.label} (${m.subject}).`));
    }
    return blocks.length ? formatHint(agent, blocks.join("\n"), "PostToolUse") : "";
}
/** A trigger's query is the rule's own words, so meaning decides; the two best fits not already loaded. */
export function triggerPicks(hits, loaded) {
    const fresh = hits.filter((h) => h.skill.description.trim().length >= 20 && !loaded.has(bareSkill(h.skill.id)) && !loaded.has(bareSkill(h.skill.name)));
    return fresh.filter((h) => (h.cos !== undefined ? h.cos >= 0.4 : h.raw >= 12)).slice(0, 2);
}
/** A `Skills:` decision anywhere in the text: line start, after a bullet/heading/emphasis, or mid-sentence ("Done. Skills: none"). */
export const DECISION = /(^|[\s>#*_`(\-])Skills?[*_`]*\s*:\s*[*_`]*\S/i;
/**
 * Stop: a main-thread turn that did real work (3+ tool calls) after skillrouter showed checks for
 * this very prompt (same prompt_id), and neither loaded a skill nor wrote a `Skills:` line, is sent
 * back once to decide. Never twice in a row (stop_hook_active), never when the turn can't be read.
 */
export function stopEvent(agent, input) {
    let p;
    try {
        p = JSON.parse(input);
    }
    catch {
        return "";
    }
    const session = sessionHash(p?.session_id);
    const prompt = sessionHash(p?.prompt_id);
    const log = (reason, extra = {}) => logUsage({ client: `hook/${agent}`, agent, tool: "decision", reason, session, prompt, ...extra });
    if (p?.stop_hook_active) {
        log("already_nudged");
        return "";
    }
    const turn = currentTurn(String(p?.transcript_path ?? ""));
    if (!turn || turn.startedAt === undefined) {
        log("no_turn");
        return "";
    }
    // This turn's checks, from the session's own state (not the shared log): same prompt_id when known, else since the prompt.
    const ids = shownFor(session, prompt, turn.startedAt - 10_000);
    const loadedNow = loadedSkills(session, undefined, turn.startedAt - 10_000); // covers turns longer than the transcript tail
    const decided = turn.loads.length > 0 || loadedNow.size > 0 || turn.texts.some((t) => DECISION.test(t)) || DECISION.test(String(p?.last_assistant_message ?? ""));
    if (!ids.length) {
        log("no_hints", { tools: turn.toolCalls });
        return "";
    }
    if (decided) {
        log("decided", { tools: turn.toolCalls, loaded: [...new Set([...turn.loads, ...loadedNow])] });
        return "";
    }
    if (turn.toolCalls < 3) {
        log("trivial", { tools: turn.toolCalls });
        return "";
    }
    log("nudged", { tools: turn.toolCalls, hinted: ids });
    return JSON.stringify({ decision: "block", reason: `skillrouter: this turn did real work and skill checks were shown (${ids.slice(0, 6).join(", ")}), but no skill was loaded and no \`Skills:\` line was written. ` +
            "Load any that fit what you just did and apply them, then reply with one line `Skills: <ids>` or `Skills: none (<why>)`. Do not repeat finished work." });
}
/**
 * Tool calls, skill loads and assistant text since the user's last real prompt, from a Claude Code
 * transcript. A real prompt is a user record with text (not a tool result, not meta) whose origin, when
 * given, is the person; notifications and subagent hand-backs don't start a turn.
 */
export function currentTurn(transcript) {
    if (!transcript)
        return null;
    const records = tailLines(transcript, 4 * 1024 * 1024).map((l) => { try {
        return JSON.parse(l);
    }
    catch {
        return null;
    } }).filter(Boolean);
    if (!records.length)
        return null;
    const isPrompt = (r) => r.type === "user" && !r.isMeta && (r.origin?.kind === undefined || r.origin.kind === "human") &&
        (typeof r.message?.content === "string" ||
            (Array.isArray(r.message?.content) && r.message.content.some((b) => b.type === "text") && !r.message.content.some((b) => b.type === "tool_result")));
    let start = records.length - 1;
    while (start >= 0 && !isPrompt(records[start]))
        start--;
    const turn = { startedAt: start >= 0 ? Date.parse(records[start].timestamp) || undefined : undefined, toolCalls: 0, loads: [], texts: [] };
    for (const r of records.slice(start + 1)) {
        if (r.type !== "assistant" || !Array.isArray(r.message?.content))
            continue;
        for (const b of r.message.content) {
            if (b.type === "text" && typeof b.text === "string")
                turn.texts.push(b.text);
            if (b.type !== "tool_use")
                continue;
            turn.toolCalls++;
            if (b.name === "Skill" && b.input?.skill)
                turn.loads.push(String(b.input.skill));
            if (/skillrouter__read_skill$/.test(b.name) && b.input?.id)
                turn.loads.push(String(b.input.id));
        }
    }
    return turn;
}
