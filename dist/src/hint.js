import { randomUUID, createHash } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs";
import { INDEX_FILE } from "./paths.js";
import { getIndex, logUsage, search } from "./search.js";
import { coreIds } from "./core.js";
import { semanticScores } from "./embed.js";
import { addGateTask, addShown, bareSkill, loadedSkills, markTurn, sessionSearched } from "./state.js";
import { endorsed, suppressed } from "./verdicts.js";
const EVENT = { gemini: "BeforeAgent" }; // claude/codex: UserPromptSubmit
const TOOL_EVENT = { gemini: "AfterTool" }; // claude/codex: PostToolUse
/** The host's hook answer carrying context for the model. `tool`: after a tool call rather than on a prompt. */
export function formatHint(agent, text, tool = false) {
    if (agent === "cursor")
        return JSON.stringify(text ? { ...(tool ? {} : { continue: true }), additional_context: text } : tool ? {} : { continue: true });
    if (!text)
        return "";
    const hookEventName = tool ? TOOL_EVENT[agent] ?? "PostToolUse" : EVENT[agent] ?? "UserPromptSubmit";
    return JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext: text } });
}
export const sessionHash = (id) => (typeof id === "string" && id ? createHash("sha256").update(id).digest("hex") : undefined);
/** The conversation a hook belongs to: session_id (Claude, Codex, Gemini, OpenCode) or Cursor's conversation_id. */
export const sessionOf = (p) => p?.session_id ?? p?.conversation_id;
/** The user turn a hook belongs to, where the host names one: Claude prompt_id, Codex turn_id, Cursor generation_id. */
export const turnOf = (p) => p?.prompt_id ?? p?.turn_id ?? p?.generation_id;
/** Host- and harness-generated turns (notifications, subagent hand-backs, command echoes) are not the user's task. */
export function isSystemText(prompt) {
    // The decision nudge itself comes back as a prompt (Cursor's follow-up, Gemini's retry, Codex's continuation).
    return /^(?:<task-notification>|<system-reminder>|\[SYSTEM NOTIFICATION|<local-command-|<command-name>|<agent-message|Another Claude session sent a message|Caveat: The messages below|# Files mentioned by the user|skillrouter: this turn did real work)/.test(prompt.trim());
}
/** A slash command (`/commit`, `/caveman lite`): its first word has no further slash, so a pasted path is a prompt. */
export function isSlashCommand(prompt) {
    return /^\/\w[\w:.-]*(?:\s|$)/.test(prompt);
}
/**
 * A prompt that points back at the conversation rather than describing work: "what's next", "continue", "do suggestion 2",
 * "go ahead with your recommendations", "fix both". Its words name the conversation, not a task, so a skill match on
 * them is a coincidence unless the meaning is unmistakable (see selectHints). Measured 2026-10-24 on 57 real prompts:
 * 20 were of this kind, and the hints they got were accepted once.
 */
export function isConversational(prompt) {
    return /\b(what(?:'?s| is| are) next|next steps?|continue|carry on|go ahead|mov(?:e|ing) forward|going forward|proceed(?:ing)?|before (?:we |i |you )?(?:move|moving|proceed|continue|close|closing|wrap)|your (recommendations?|suggestions?|plan|proposal|review|findings)|(suggestion|item|step|option|recommendation|point|phase|stage)s? \d|the (first|second|third|last) one|as (discussed|planned|above|before|suggested)|do (it|that|this|all|both|them)|yes[,.]? (build|do|go|fix|implement|proceed|start)|fix (both|these|those|it|that|them)|sounds? good|looks? good|that works)\b/i.test(prompt);
}
/**
 * The lexical floor a hint must clear. Calibrated 2026-10-23 on a 4,500-skill library (real matches raw 28-44, small
 * talk ~13). BM25 scores grow with the log of the library size (rare terms weigh more in a big library), so the floor
 * scales the same way: a 450-skill library gets about 0.7 of it. SKILLROUTER_MIN_RAW sets an absolute floor instead.
 */
export function minRawFor(skills) {
    const raw = process.env.SKILLROUTER_MIN_RAW;
    if (raw !== undefined && raw.trim() !== "" && Number.isFinite(Number(raw)))
        return Number(raw);
    return Math.round(20 * Math.log(Math.max(2, skills)) / Math.log(4500) * 10) / 10;
}
/** Reads the hook JSON on stdin, prints the agent-specific hook output. Never blocks a prompt. */
export async function hint(agent, input, minRaw, k = 3) {
    const started = performance.now();
    const hint_id = randomUUID();
    let payload = {};
    let semStatus;
    const record = (reason, hits = []) => logUsage({
        client: `hook/${agent}`, agent, tool: "hint", hint_id, reason, session: sessionHash(sessionOf(payload)), prompt: sessionHash(turnOf(payload)),
        sem: semStatus, ...(payload.sem_error ? { sem_error: payload.sem_error } : {}), duration_ms: Math.round(performance.now() - started), hits: hits.map((h) => [h.skill.id, h.score, h.raw, h.cos ?? null]),
    });
    try {
        const parsed = JSON.parse(input);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || typeof parsed.prompt !== "string")
            throw new Error();
        payload = parsed;
    }
    catch {
        record("invalid_input");
        return formatHint(agent, "");
    }
    const session = sessionHash(sessionOf(payload));
    const prompt = payload.prompt.trim();
    // Every prompt starts a turn, checked or not: the end-of-turn nudge counts work from here. The nudge itself
    // coming back as a prompt (Cursor's follow-up, Gemini's retry, Codex's continuation) belongs to the nudged turn.
    if (!/^skillrouter: this turn did real work/.test(prompt))
        markTurn(session, sessionHash(turnOf(payload)));
    if (isSlashCommand(prompt)) {
        record("skipped_command");
        return formatHint(agent, "");
    }
    if (isSystemText(prompt)) {
        record("skipped_system");
        return formatHint(agent, "");
    }
    // A prompt that describes work is a task turn: the search gate (gate.ts) holds its first work call until the agent has searched.
    // A short or conversational one ("fix the login bug", "go ahead and implement it") carries on earlier work, so it is a task
    // turn only while the session has not searched at all.
    if ((prompt.length >= 20 && !isConversational(prompt)) || !sessionSearched(session))
        addGateTask(session, sessionHash(turnOf(payload)));
    if (prompt.length < 20) {
        record("skipped_short_prompt");
        return formatHint(agent, "");
    }
    let hits = [];
    let core = new Set();
    try {
        const query = prompt.slice(0, 1000);
        const { index } = getIndex();
        minRaw ??= minRawFor(index.skills.length);
        const sem = await semanticScores(query, 800, index.builtAt);
        semStatus = sem.status;
        const loaded = loadedSkills(session, undefined); // already in context this session: not hinted again
        core = coreIds();
        // Loaded skills and those agents keep declining (verdicts.json) are not offered.
        if (sem.status === "error")
            payload = { ...payload, sem_error: sem.error };
        hits = selectHints(await search(query, 12, { semantic: sem.scores, known: new Set([...loaded, ...suppressed(agent)]), prefer: core }), minRaw, k, { conversational: isConversational(prompt), trusted: endorsed(agent) });
    }
    catch {
        record(fs.existsSync(INDEX_FILE) ? "index_error" : "missing_index");
        return formatHint(agent, "");
    }
    record(hits.length ? "shown" : "no_match", hits);
    if (!hits.length)
        return formatHint(agent, "");
    // Named siblings count as shown, so a later trigger this turn doesn't offer them again.
    addShown(session, hits.map((h) => h.skill.id), sessionHash(turnOf(payload)), Object.fromEntries(hits.filter((h) => h.similar?.length).map((h) => [h.skill.id, h.similar])));
    return formatHint(agent, hintText(hits, hint_id, core, agent));
}
/**
 * Which candidates become a hint. A hint costs context on every prompt, so only a confident match is shown; the
 * agent's own search_skills remains the path for everything weaker.
 *
 * With the semantic layer, a skill passes on meaning alone (cosine >= 0.5), or on meaning plus words that mean
 * something (cosine >= 0.4 with two or more specific words matched and the lexical floor). A conversational prompt
 * ("what's next", "do suggestion 2") passes only on unmistakable meaning (cosine >= 0.55): its words name the
 * conversation, not a task. Without the layer: the lexical floor, two matched words, one of them specific; nothing on
 * a conversational prompt. Candidates stay within a margin of the best one (0.12 in cosine, 15% in BM25), at most k.
 *
 * `trusted` (see verdicts.ts endorsed): skills this host keeps accepting pass on a lower bar, meaning 0.4 alone or 0.2
 * with three matched words, one specific (0.45 on a conversational prompt), and are not held to the margin: a weak
 * match for a skill the agent uses every time is worth more than a strong match for an unknown one.
 *
 * Calibrated 2026-10-24 on 57 real prompts from this machine's hosts (48 got a hint before, 13 after; hints on
 * prompts that needed none fell from 29 to 7) and the bundled fixture (recall and precision unchanged).
 */
export function selectHints(hits, minRaw, k, options = {}) {
    const described = hits.filter((h) => h.skill.description.trim().length >= 20);
    const semantic = described.some((h) => h.cos !== undefined);
    const specific = (h) => h.specific ?? h.matched; // (a hit built without the count: every matched word counts)
    const trusted = (h) => !!options.trusted && (options.trusted.has(bareSkill(h.skill.id)) || options.trusted.has(bareSkill(h.skill.name)));
    const lexical = (h) => h.matched >= 2 && h.raw >= minRaw && (specific(h) >= 1 || trusted(h));
    if (!semantic) {
        if (options.conversational)
            return [];
        const passing = described.filter(lexical).sort((a, b) => b.raw - a.raw);
        const top = passing[0]?.raw ?? 0;
        return passing.filter((h) => trusted(h) || h.raw >= 0.85 * top).slice(0, k);
    }
    // A hit without a vector (new since the last embedding run) is judged by the lexical gate, on a comparable scale.
    const strength = (h) => (h.cos !== undefined ? h.cos : Math.min(0.5, h.raw / 100 + 0.25));
    const passes = (h) => h.cos === undefined
        ? lexical(h) && !options.conversational
        : trusted(h)
            ? (options.conversational ? h.cos >= 0.45 : h.cos >= 0.4 || (h.cos >= 0.2 && h.matched >= 3 && specific(h) >= 1 && h.raw >= minRaw))
            : options.conversational ? h.cos >= 0.55 : h.cos >= 0.5 || (h.cos >= 0.4 && specific(h) >= 2 && h.raw >= minRaw);
    const passing = described.filter(passes).sort((a, b) => strength(b) - strength(a));
    const top = passing.find((h) => !trusted(h)) ? strength(passing.find((h) => !trusted(h))) : 0;
    return passing.filter((h) => trusted(h) || strength(h) >= top - 0.12).slice(0, k);
}
/** The hint the model reads: a required decision, each candidate's trigger, and the exact way to load it. */
export function hintText(hits, hint_id, core, agent = "claude", lead) {
    const lines = hits.map((h) => {
        const id = h.skill.id;
        const how = core.has(id) // resolved core ids (coreIds): a same-named variant with other text is not preloaded
            ? (agent === "claude" ? "preloaded: invoke it with the Skill tool" : `preloaded: use the skill named ${id} from your skill list`)
            : `not preloaded: read_skill("${id}", hint_id="${hint_id}")`;
        const similar = h.similar?.length ? `\n  similar (load instead if closer): ${h.similar.join(", ")}` : "";
        return `- ${id} — ${how}\n  when: ${(h.skill.description || "(no description)").split(/\s+/).join(" ").slice(0, 220)}${similar}`;
    }).join("\n");
    return lead
        ? `${lead} Load the ones whose "when" fits what you are doing before continuing, and include them in your \`Skills:\` line (the one that also ends your final reply).\n${lines}`
        : "Skill check (skillrouter). Load every skill below whose \"when\" fits this task (often 1-3) before starting the work, then say which in one line: `Skills: <ids>` or `Skills: none (<why>)`. End your final reply with that line too.\n" + lines;
}
/** Run work in a killable process: synchronous index work cannot defeat the deadline. */
export function runHint(agent, input, cli, timeout = 1500, mode) {
    const started = performance.now();
    return new Promise((resolve) => {
        const child = execFile(process.execPath, [cli, "hint-worker", agent, ...(mode ? [mode] : [])], {
            timeout, killSignal: "SIGKILL", maxBuffer: 64 * 1024, windowsHide: true,
        }, (error, stdout) => {
            // A worker killed after it already wrote a complete answer (e.g. a slow model load still pending) keeps that answer.
            const answer = stdout.trim();
            if (error && answer) {
                try {
                    JSON.parse(answer);
                    resolve(answer);
                    return;
                }
                catch { /* partial: fall through */ }
            }
            if (error) {
                logUsage({ client: `hook/${agent}`, agent, tool: mode === "tool" ? "trigger" : "hint", reason: error.killed ? "timeout" : "execution_error",
                    duration_ms: Math.round(performance.now() - started), hits: [] });
                resolve(mode ? "" : formatHint(agent, ""));
            }
            else
                resolve(stdout.trim());
        });
        child.stdin?.on("error", () => { });
        child.stdin?.end(input);
    });
}
/** Bound stdin too: a host that never closes its pipe must not hang prompt submission. Tool events carry tool output, so their cap is higher. */
export function readHintInput(agent, timeout = 1500, cap = 256 * 1024) {
    return new Promise((resolve) => {
        let input = "";
        const done = (reason) => {
            clearTimeout(timer);
            process.stdin.removeListener("data", onData);
            process.stdin.removeListener("end", onEnd);
            process.stdin.removeListener("error", onError);
            process.stdin.pause();
            if (reason)
                logUsage({ client: `hook/${agent}`, agent, tool: "hint", reason, hits: [] });
            resolve(reason ? null : input);
        };
        const onData = (chunk) => {
            input += chunk;
            if (input.length > cap)
                done("input_too_large");
        };
        const onEnd = () => done();
        const onError = () => done("invalid_input");
        const timer = setTimeout(() => done("input_timeout"), timeout);
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", onData).once("end", onEnd).once("error", onError);
        process.stdin.resume();
    });
}
