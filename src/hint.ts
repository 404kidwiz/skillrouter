import { randomUUID, createHash } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs";
import { INDEX_FILE } from "./paths.js";
import type { AgentId } from "./paths.js";
import { getIndex, logUsage, search, type Hit } from "./search.js";
import { coreIds } from "./core.js";
import { semanticScores } from "./embed.js";
import { addShown, bareSkill, loadedSkills, markTurn } from "./state.js";
import { suppressed } from "./verdicts.js";

const EVENT: Partial<Record<AgentId, string>> = { gemini: "BeforeAgent" }; // claude/codex: UserPromptSubmit
const TOOL_EVENT: Partial<Record<AgentId, string>> = { gemini: "AfterTool" }; // claude/codex: PostToolUse

/** The host's hook answer carrying context for the model. `tool`: after a tool call rather than on a prompt. */
export function formatHint(agent: AgentId, text: string, tool = false): string {
  if (agent === "cursor") return JSON.stringify(text ? { ...(tool ? {} : { continue: true }), additional_context: text } : tool ? {} : { continue: true });
  if (!text) return "";
  const hookEventName = tool ? TOOL_EVENT[agent] ?? "PostToolUse" : EVENT[agent] ?? "UserPromptSubmit";
  return JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext: text } });
}

export const sessionHash = (id: unknown) => (typeof id === "string" && id ? createHash("sha256").update(id).digest("hex") : undefined);

/** The conversation a hook belongs to: session_id (Claude, Codex, Gemini, OpenCode) or Cursor's conversation_id. */
export const sessionOf = (p: any): unknown => p?.session_id ?? p?.conversation_id;

/** The user turn a hook belongs to, where the host names one: Claude prompt_id, Codex turn_id, Cursor generation_id. */
export const turnOf = (p: any): unknown => p?.prompt_id ?? p?.turn_id ?? p?.generation_id;

/** Host- and harness-generated turns (notifications, subagent hand-backs, command echoes) are not the user's task. */
export function isSystemText(prompt: string): boolean {
  // The decision nudge itself comes back as a prompt (Cursor's follow-up, Gemini's retry, Codex's continuation).
  return /^(?:<task-notification>|<system-reminder>|\[SYSTEM NOTIFICATION|<local-command-|<command-name>|<agent-message|Another Claude session sent a message|Caveat: The messages below|skillrouter: this turn did real work)/.test(prompt.trim());
}

/** Reads the hook JSON on stdin, prints the agent-specific hook output. Never blocks a prompt. */
// Lexical floor calibrated 2026-10-23 on a 4,500-skill library (real matches raw 28-44, small talk ~13). Override with SKILLROUTER_MIN_RAW.
export async function hint(agent: AgentId, input: string, minRaw = Number(process.env.SKILLROUTER_MIN_RAW ?? 20), k = 4): Promise<string> {
  const started = performance.now();
  const hint_id = randomUUID();
  let payload: Record<string, unknown> = {};
  let semStatus: string | undefined;
  const record = (reason: string, hits: Hit[] = []) => logUsage({
    client: `hook/${agent}`, agent, tool: "hint", hint_id, reason, session: sessionHash(sessionOf(payload)), prompt: sessionHash(turnOf(payload)),
    sem: semStatus, duration_ms: Math.round(performance.now() - started), hits: hits.map((h) => [h.skill.id, h.score, h.raw, h.cos ?? null]),
  });
  try {
    const parsed = JSON.parse(input);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || typeof parsed.prompt !== "string") throw new Error();
    payload = parsed;
  } catch { record("invalid_input"); return formatHint(agent, ""); }
  const session = sessionHash(sessionOf(payload));
  const prompt = (payload.prompt as string).trim();
  // Every prompt starts a turn, checked or not: the end-of-turn nudge counts work from here. The nudge itself
  // coming back as a prompt (Cursor's follow-up, Gemini's retry, Codex's continuation) belongs to the nudged turn.
  if (!/^skillrouter: this turn did real work/.test(prompt)) markTurn(session, sessionHash(turnOf(payload)));
  if (prompt.startsWith("/")) { record("skipped_command"); return formatHint(agent, ""); }
  if (isSystemText(prompt)) { record("skipped_system"); return formatHint(agent, ""); }
  if (prompt.length < 20) { record("skipped_short_prompt"); return formatHint(agent, ""); }
  let hits: Hit[] = [];
  let core = new Set<string>();
  try {
    const query = prompt.slice(0, 1000);
    const { index } = getIndex();
    const sem = await semanticScores(query, 800, index.builtAt);
    semStatus = sem.status;
    const loaded = loadedSkills(session, undefined); // already in context this session: not hinted again
    core = coreIds();
    // Loaded skills and those agents keep declining (verdicts.json) are not offered.
    hits = selectHints(await search(query, 12, { semantic: sem.scores, known: new Set([...loaded, ...suppressed(agent)]), prefer: core }), minRaw, k);
  } catch {
    record(fs.existsSync(INDEX_FILE) ? "index_error" : "missing_index");
    return formatHint(agent, "");
  }
  record(hits.length ? "shown" : "no_match", hits);
  if (!hits.length) return formatHint(agent, "");
  // Named siblings count as shown, so a later trigger this turn doesn't offer them again.
  addShown(session, hits.map((h) => h.skill.id), sessionHash(turnOf(payload)), Object.fromEntries(hits.filter((h) => h.similar?.length).map((h) => [h.skill.id, h.similar!])));
  return formatHint(agent, hintText(hits, hint_id, core, agent));
}

/**
 * Which candidates become a hint. With the semantic layer: a skill passes on strong meaning alone
 * (cosine >= 0.45) or on words and meaning together (cosine >= 0.20 and cosine + raw/100 >= 0.52);
 * calibrated 2026-10-23 on 16 labeled prompts, it drops every labeled junk hit but one name collision.
 * Without it: the lexical gate. Either way only described skills, near the best one, at most k.
 */
export function selectHints(hits: Hit[], minRaw: number, k: number): Hit[] {
  const described = hits.filter((h) => h.skill.description.trim().length >= 20);
  const semantic = described.some((h) => h.cos !== undefined);
  // A hit without a vector (new since the last embedding run) is judged by the lexical gate, on a comparable scale.
  const strength = (h: Hit) => (!semantic ? h.raw : h.cos !== undefined ? h.cos + h.raw / 100 : h.raw / 100 + 0.25);
  const passes = (h: Hit) => h.cos === undefined
    ? h.matched >= 2 && h.raw >= minRaw
    : h.cos >= 0.45 || (h.cos >= 0.2 && h.matched >= 1 && strength(h) >= 0.52);
  const passing = described.filter(passes).sort((a, b) => strength(b) - strength(a));
  const top = passing[0] ? strength(passing[0]) : 0;
  return passing.filter((h) => strength(h) >= (semantic ? 0.8 : 0.85) * top).slice(0, k);
}

/** The hint the model reads: a required decision, each candidate's trigger, and the exact way to load it. */
export function hintText(hits: Hit[], hint_id: string, core: Set<string>, agent: AgentId = "claude", lead?: string): string {
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
export function runHint(agent: AgentId, input: string, cli: string, timeout = 1500, mode?: string): Promise<string> {
  const started = performance.now();
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [cli, "hint-worker", agent, ...(mode ? [mode] : [])], {
      timeout, killSignal: "SIGKILL", maxBuffer: 64 * 1024,
    }, (error, stdout) => {
      // A worker killed after it already wrote a complete answer (e.g. a slow model load still pending) keeps that answer.
      const answer = stdout.trim();
      if (error && answer) { try { JSON.parse(answer); resolve(answer); return; } catch { /* partial: fall through */ } }
      if (error) {
        logUsage({ client: `hook/${agent}`, agent, tool: mode === "tool" ? "trigger" : "hint", reason: error.killed ? "timeout" : "execution_error",
          duration_ms: Math.round(performance.now() - started), hits: [] });
        resolve(mode ? "" : formatHint(agent, ""));
      } else resolve(stdout.trim());
    });
    child.stdin?.on("error", () => {});
    child.stdin?.end(input);
  });
}

/** Bound stdin too: a host that never closes its pipe must not hang prompt submission. Tool events carry tool output, so their cap is higher. */
export function readHintInput(agent: AgentId, timeout = 1500, cap = 256 * 1024): Promise<string | null> {
  return new Promise((resolve) => {
    let input = "";
    const done = (reason?: string) => {
      clearTimeout(timer);
      process.stdin.removeListener("data", onData);
      process.stdin.removeListener("end", onEnd);
      process.stdin.removeListener("error", onError);
      process.stdin.pause();
      if (reason) logUsage({ client: `hook/${agent}`, agent, tool: "hint", reason, hits: [] });
      resolve(reason ? null : input);
    };
    const onData = (chunk: string) => {
      input += chunk;
      if (input.length > cap) done("input_too_large");
    };
    const onEnd = () => done();
    const onError = () => done("invalid_input");
    const timer = setTimeout(() => done("input_timeout"), timeout);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", onData).once("end", onEnd).once("error", onError);
    process.stdin.resume();
  });
}
