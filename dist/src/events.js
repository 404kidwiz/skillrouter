import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { INDEX_FILE } from "./paths.js";
import { getIndex, logUsage, search } from "./search.js";
import { coreIds } from "./core.js";
import { semanticScores } from "./embed.js";
import { formatHint, hintText, sessionHash, sessionOf, turnOf } from "./hint.js";
import { actionOf, commandsOf, isWork, matchTriggers, parsedInput, shellCommand } from "./triggers.js";
import { addLoaded, addShown, addTool, bareSkill, claim, claimed, loadedSkills, release, shownFor, turnStats } from "./state.js";
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
/** The session's working directory; Cursor tool events may carry only workspace_roots. */
const cwdOf = (p) => p?.cwd ?? (Array.isArray(p?.workspace_roots) ? p.workspace_roots[0] : undefined);
/** File paths relative to the session's working directory, so folders above the repo (…/auth-service/…) don't trigger rules. */
function relativeAction(action, cwd) {
    if (typeof cwd !== "string" || !cwd)
        return action;
    const rel = (f) => { const r = path.relative(cwd, f); return r && !r.startsWith("..") && !path.isAbsolute(r) ? r : f; };
    return { ...action, ...(action.file ? { file: rel(action.file) } : {}), ...(action.files ? { files: action.files.map(rel) } : {}) };
}
/** The skill a path names when it is a skill folder's SKILL.md (`…/<name>/SKILL.md`); never ".", ".." or a glob. */
function skillOfPath(p) {
    if (typeof p !== "string" || !/(^|[\/\\])SKILL\.md$/.test(p))
        return null;
    const name = path.basename(path.dirname(p));
    return /^[\w@+-][\w.@+-]*$/.test(name) ? name : null;
}
const READ_TOOL = /^(Read|ReadFile|read_file|read|view)$/i;
const SHELL_TOOL = /^(Bash|Shell|shell|run_shell_command|exec_command)$/i;
const READERS = /^(cat|head|tail|bat|less|more|nl|sed)$/;
/**
 * The skill a shell script prints: a reader (cat, head, sed …) at the head of one of its commands,
 * with a SKILL.md as its own argument, and no redirection or tee (that would be writing it).
 * `grep x SKILL.md | head`, `ls …/SKILL.md`, `cat > SKILL.md <<EOF` and `sed -i` are not loads.
 */
export function skillReadIn(script) {
    const text = script.replace(/"([^"\s]*)"|'([^'\s]*)'/g, (_m, a, b) => a ?? b); // a quoted path is just a path
    const segments = commandsOf(text).map((s) => s.replace(/^\(+/, ""));
    if (segments.some((s) => /^tee\b/.test(s)))
        return null; // `cat a | tee b` copies a skill file, it doesn't load one
    for (const seg of segments) {
        if (/(?<![2&])>(?!&)/.test(seg))
            continue; // writing the file (`> SKILL.md`); `2>/dev/null` is fine
        const [head, ...args] = seg.split(/\s+/);
        const cmd = path.basename(head);
        if (!READERS.test(cmd) || (cmd === "sed" && args.some((x) => /^-\w*i/.test(x) || x.startsWith("--in-place"))))
            continue;
        for (const x of args) {
            const s = skillOfPath(x);
            if (s)
                return s;
        }
    }
    return null;
}
// The router's read_skill under each host's MCP naming: mcp__skillrouter__read_skill, mcp__plugin_skillrouter_skillrouter__read_skill,
// mcp_skillrouter_read_skill (Gemini), skillrouter_read_skill (OpenCode), MCP:read_skill (Cursor). Other servers' read_skill don't count.
const ROUTER_READ = /(^|_)skillrouter_{1,2}read_skill$|^MCP:read_skill$/;
/**
 * The skill a tool call loads, on any host: Claude's Skill tool, the router's read_skill (also inside
 * Cursor's MCP wrapper tools), Gemini's activate_skill, OpenCode's skill tool, and reads of a SKILL.md.
 */
export function skillLoadOf(tool, raw) {
    const input = parsedInput(raw);
    if (tool === "Skill" && input?.skill)
        return { skill: String(input.skill), via: "Skill" };
    if (ROUTER_READ.test(tool) && input?.id)
        return { skill: String(input.id), via: "read_skill" };
    // Cursor transcripts wrap MCP calls: { toolName, arguments, namespace | server }.
    if (input && typeof input.toolName === "string" && /(^|_)read_skill$/.test(input.toolName) && /skillrouter/.test(String(input.server ?? input.namespace ?? ""))) {
        const args = parsedInput(input.arguments);
        if (args?.id)
            return { skill: String(args.id), via: "read_skill" };
    }
    if (/^(activate_skill|skill)$/.test(tool) && input?.name)
        return { skill: String(input.name), via: tool };
    if (READ_TOOL.test(tool) && input && typeof input === "object") {
        for (const k of ["file_path", "path", "filePath", "absolute_path", "target_file"]) {
            const s = skillOfPath(input[k]);
            if (s)
                return { skill: s, via: "file" };
        }
    }
    if (SHELL_TOOL.test(tool)) {
        const s = skillReadIn(shellCommand(input));
        if (s)
            return { skill: s, via: "file" };
    }
    return null;
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
    const session = sessionHash(sessionOf(p));
    const sub = sessionHash(p?.agent_id);
    const turn = sessionHash(turnOf(p));
    const load = skillLoadOf(tool, p?.tool_input);
    if (load && !inWorker) {
        addLoaded(session, load.skill, sub);
        logUsage({ client: `hook/${agent}`, agent, tool: "skill_load", via: load.via,
            skill: load.skill, hint_id: parsedInput(p?.tool_input)?.hint_id, session, sub, prompt: turn });
    }
    // `cat …/SKILL.md && pytest` is a load and work: keep going.
    if (inWorker) {
        const claimed = Array.isArray(p?._claimed) ? p._claimed : [];
        const action = actionOf(tool, p?.tool_input);
        if (!action || !claimed.length)
            return "";
        return triggerHints(agent, relativeAction(action, cwdOf(p)), claimed, session, sub, turn);
    }
    const action = actionOf(tool, p?.tool_input);
    // Work done this turn (edits, commands that do more than read), for hosts whose end-of-turn check counts it here.
    if (isWork(action))
        addTool(session, turn, sub);
    // No session (nothing to dedupe against) or no index (nothing to suggest): never claim, never fire.
    if (!action || !session || !fs.existsSync(INDEX_FILE))
        return "";
    // At most two rules per call, and only those two are claimed, so no rule is used up without being shown.
    // A rule that had nothing new to show this turn rests until the next turn (see triggerHints).
    const matches = matchTriggers(relativeAction(action, cwdOf(p))).slice(0, 2);
    const tag = turnTag(session, turn);
    const resting = (m) => claimed(session, `${ruleKey(m.trigger.id, sub)}@${tag}`);
    const taken = matches.filter((m) => {
        if (resting(m) || !claim(session, ruleKey(m.trigger.id, sub)))
            return false;
        // A worker may have rested the rule between the check and the claim: give the claim back.
        if (resting(m)) {
            release(session, ruleKey(m.trigger.id, sub));
            return false;
        }
        return true;
    }).map((m) => m.trigger.id);
    if (!taken.length)
        return "";
    // Searching (and maybe loading the model) runs in a killable worker; it gets the claimed rules, not the tool output.
    return { spawn: JSON.stringify({ ...p, _claimed: taken, tool_response: undefined, tool_output: undefined }) };
}
/** A trigger rule's claim: once per session, per agent (subagents have their own). */
const ruleKey = (id, sub) => `${id}${sub ? "-" + sub.slice(0, 12) : ""}`;
/** The current turn, for claims that last one turn: the host's turn id, else when the prompt hook marked it. */
const turnTag = (session, turn) => turn?.slice(0, 16) ?? String(turnStats(session).start ?? "none");
async function triggerHints(agent, action, claimed, session, sub, prompt) {
    const loaded = loadedSkills(session, sub);
    // Skills this turn already showed (prompt check, earlier triggers) aren't repeated: the main thread just saw them.
    // Subagents never saw the main thread's checks, so they get the full list.
    const shownNow = new Set(sub ? [] : shownFor(session, prompt, turnStats(session, prompt).start ?? Date.now()).map(bareSkill));
    const prefer = coreIds();
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
        // Shown or loaded skills, and their copies, are left out of the search itself.
        const hits = triggerPicks(await search(m.query, 10, { semantic: sem.scores, known: new Set([...loaded, ...shownNow]), prefer }), loaded, shownNow);
        const repeat = !hits.length && shownNow.size > 0 && triggerPicks(await search(m.query, 10, { semantic: sem.scores, known: loaded, prefer }), loaded).length > 0;
        logUsage({ client: `hook/${agent}`, agent, tool: "trigger", trigger: m.trigger.id, hint_id, session, sub, prompt, sem: sem.status,
            reason: hits.length ? "shown" : repeat ? "already_shown" : "no_match", hits: hits.map((h) => [h.skill.id, h.score, h.raw, h.cos ?? null]) });
        // Nothing new to say: rest the rule for this turn instead of using it up for the session.
        if (repeat) {
            claim(session, `${ruleKey(m.trigger.id, sub)}@${turnTag(session, prompt)}`);
            release(session, ruleKey(m.trigger.id, sub));
        }
        if (!hits.length)
            continue;
        for (const h of hits)
            for (const id of [h.skill.id, ...(h.similar ?? [])])
                shownNow.add(bareSkill(id)); // the second rule of this call doesn't repeat the first
        if (!sub)
            addShown(session, hits.flatMap((h) => [h.skill.id, ...(h.similar ?? [])]), prompt);
        blocks.push(hintText(hits, hint_id, prefer, agent, `Skill check (skillrouter): you ${m.trigger.label} (${m.subject}).`));
    }
    return blocks.length ? formatHint(agent, blocks.join("\n"), true) : "";
}
/** A trigger's query is the rule's own words, so meaning decides; the two best fits not already loaded or shown this turn. */
export function triggerPicks(hits, loaded, shown = new Set()) {
    const known = (h) => [h.skill.id, h.skill.name].some((x) => loaded.has(bareSkill(x)) || shown.has(bareSkill(x)));
    const fresh = hits.filter((h) => h.skill.description.trim().length >= 20 && !known(h));
    return fresh.filter((h) => (h.cos !== undefined ? h.cos >= 0.4 : h.raw >= 12)).slice(0, 2);
}
/** A `Skills:` decision anywhere in the text: line start, after a bullet/heading/emphasis, or mid-sentence ("Done. Skills: none"). */
export const DECISION = /(^|[\s>#*_`(\-])Skills?[*_`]*\s*:\s*[*_`]*\S/i;
/** How each host is told to go back and decide: Claude/Codex continue on Stop, Cursor submits a follow-up, Gemini retries. */
function nudgeOutput(agent, reason) {
    if (agent === "cursor")
        return JSON.stringify({ followup_message: reason });
    if (agent === "gemini")
        return JSON.stringify({ decision: "deny", reason: reason + " Then give your final answer again." });
    return JSON.stringify({ decision: "block", reason });
}
/**
 * End of turn (Claude/Codex Stop, Cursor stop, Gemini AfterAgent): a main-thread turn that did real
 * work (3+ tool calls) after skillrouter showed checks for this very turn, and neither loaded a skill
 * nor wrote a `Skills:` line, is sent back once to decide. Never twice in a row (stop_hook_active,
 * Cursor's loop_count), never after an aborted turn, never when the turn can't be read.
 * Claude's and Cursor's transcripts give the turn's tool calls and text; Codex and Gemini send the
 * final text, and their work is counted by the tool hook since the prompt hook marked the turn.
 */
export function stopEvent(agent, input) {
    let p;
    try {
        p = JSON.parse(input);
    }
    catch {
        return "";
    }
    const session = sessionHash(sessionOf(p));
    const prompt = sessionHash(turnOf(p));
    const log = (reason, extra = {}) => logUsage({ client: `hook/${agent}`, agent, tool: "decision", reason, session, prompt, ...extra });
    if (p?.stop_hook_active || Number(p?.loop_count) > 0) {
        log("already_nudged");
        return "";
    }
    if (agent === "cursor" && typeof p?.status === "string" && p.status !== "completed") {
        log("not_completed");
        return "";
    }
    const turn = agent === "claude" || agent === "cursor" ? currentTurn(String(p?.transcript_path ?? "")) : null;
    // Cursor may call stop before the final text reaches its transcript: without it a written `Skills:` line can't be seen.
    if (agent === "cursor" && turn && !turn.endsWithText) {
        log("unflushed");
        return "";
    }
    const stats = turnStats(session, prompt);
    // Claude's transcript is timestamped (allow for clock skew); Cursor's isn't, so its turn starts at the prompt hook's mark.
    const since = turn?.startedAt !== undefined ? turn.startedAt - 10_000 : stats.start;
    // Cursor sends no final text: without its transcript a written `Skills:` line can't be seen, so don't nudge.
    if (since === undefined || ((agent === "claude" || agent === "cursor") && !turn)) {
        log("no_turn");
        return "";
    }
    // Claude counts every tool call (unchanged); Cursor counts work (edits, commands), since its nudge is a visible message.
    const toolCalls = !turn ? stats.tools : agent === "cursor" ? turn.work : turn.toolCalls;
    // This turn's checks, from the session's own state (not the shared log): same turn id when known, else since the prompt.
    const ids = shownFor(session, prompt, since);
    const loadedNow = loadedSkills(session, undefined, since); // covers turns longer than the transcript tail
    const lastText = String(p?.last_assistant_message ?? p?.prompt_response ?? ""); // Gemini's prompt_response is the whole turn's text
    // Codex sends only the final message; the `Skills:` line usually comes first, so read the turn's text from its transcript.
    const codexTexts = agent === "codex" ? codexTurnTexts(String(p?.transcript_path ?? ""), String(p?.turn_id ?? ""), since) : null;
    const texts = [...(turn?.texts ?? []), ...(codexTexts ?? []), lastText];
    const decided = (turn?.loads.length ?? 0) > 0 || loadedNow.size > 0 || texts.some((x) => DECISION.test(x));
    if (!ids.length) {
        log("no_hints", { tools: toolCalls });
        return "";
    }
    if (decided) {
        log("decided", { tools: toolCalls, loaded: [...new Set([...(turn?.loads ?? []), ...loadedNow])] });
        return "";
    }
    if (toolCalls < 3) {
        log("trivial", { tools: toolCalls });
        return "";
    }
    if (agent === "codex" && codexTexts === null) {
        log("no_transcript", { tools: toolCalls });
        return "";
    }
    log("nudged", { tools: toolCalls, hinted: ids });
    return nudgeOutput(agent, `skillrouter: this turn did real work and skill checks were shown (${ids.slice(0, 6).join(", ")}), but no skill was loaded and no \`Skills:\` line was written. ` +
        "Load any that fit what you just did and apply them, then reply with one line `Skills: <ids>` or `Skills: none (<why>)`. Do not repeat finished work.");
}
/**
 * Tool calls, skill loads and assistant text since the user's last real prompt, from a Claude Code or
 * Cursor transcript (Claude records carry `type` and timestamps, Cursor's carry `role` only). A real
 * prompt is a user record with text (not a tool result, not meta) whose origin, when given, is the
 * person; notifications and subagent hand-backs don't start a turn.
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
    const kind = (r) => r.type ?? r.role;
    const isPrompt = (r) => kind(r) === "user" && !r.isMeta && (r.origin?.kind === undefined || r.origin.kind === "human") &&
        (typeof r.message?.content === "string" ||
            (Array.isArray(r.message?.content) && r.message.content.some((b) => b.type === "text") && !r.message.content.some((b) => b.type === "tool_result")));
    let start = records.length - 1;
    while (start >= 0 && !isPrompt(records[start]))
        start--;
    if (start < 0)
        return null; // no prompt in the tail: the turn can't be read
    const turn = { startedAt: Date.parse(records[start].timestamp) || undefined, toolCalls: 0, work: 0, loads: [], texts: [], endsWithText: false };
    for (const r of records.slice(start + 1)) {
        if (kind(r) !== "assistant" || !Array.isArray(r.message?.content))
            continue;
        for (const b of r.message.content) {
            if (b.type === "text" && typeof b.text === "string") {
                turn.texts.push(b.text);
                turn.endsWithText = b.text.trim().length > 0;
            }
            if (b.type !== "tool_use")
                continue;
            turn.toolCalls++;
            turn.endsWithText = false;
            const load = skillLoadOf(String(b.name ?? ""), b.input);
            if (load)
                turn.loads.push(load.skill);
            if (isWork(actionOf(String(b.name ?? ""), b.input)))
                turn.work++;
        }
    }
    return turn;
}
/**
 * Assistant text of one Codex turn, from its rollout transcript: assistant messages carry their
 * turn id (older records without one count by time). Null when the transcript can't be read.
 * The rollout format is not a stable interface, so anything unexpected reads as "no transcript".
 */
export function codexTurnTexts(transcript, turnId, since) {
    if (!transcript)
        return null;
    const TAIL = 4 * 1024 * 1024;
    let size = 0;
    try {
        size = fs.statSync(transcript).size;
    }
    catch {
        return null;
    }
    const lines = tailLines(transcript, TAIL);
    if (!lines.length)
        return null;
    const texts = [];
    let mine = 0;
    let sawEarlier = size <= TAIL; // a cut tail must still reach back before this turn, or its first messages may be missing
    for (const l of lines) {
        if (!sawEarlier) {
            const ts = /"timestamp":"([^"]+)"/.exec(l.slice(0, 120))?.[1];
            if ((ts && since !== undefined && Date.parse(ts) < since) || (turnId && /"turn_id":"/.test(l) && !l.includes(`"turn_id":"${turnId}"`)))
                sawEarlier = true;
        }
        if (!l.includes('"assistant"'))
            continue;
        let r;
        try {
            r = JSON.parse(l);
        }
        catch {
            continue;
        }
        const p = r?.payload;
        if (r?.type !== "response_item" || p?.type !== "message" || p?.role !== "assistant" || !Array.isArray(p.content))
            continue;
        const id = p.internal_chat_message_metadata_passthrough?.turn_id;
        if (turnId && id ? id !== turnId : !(since !== undefined && Date.parse(r.timestamp) >= since))
            continue;
        mine++;
        for (const b of p.content)
            if (typeof b?.text === "string")
                texts.push(b.text);
    }
    // Nothing recognized for this turn (format change, unflushed) or the turn's start is out of reach: can't tell.
    return mine && sawEarlier ? texts : null;
}
