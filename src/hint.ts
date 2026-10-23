import type { AgentId } from "./paths.js";
import { logUsage, search } from "./search.js";

const EVENT: Partial<Record<AgentId, string>> = { gemini: "BeforeAgent" }; // claude/codex: UserPromptSubmit

export function formatHint(agent: AgentId, text: string): string {
  if (agent === "cursor") return JSON.stringify(text ? { continue: true, additional_context: text } : { continue: true });
  if (!text) return "";
  return JSON.stringify({ hookSpecificOutput: { hookEventName: EVENT[agent] ?? "UserPromptSubmit", additionalContext: text } });
}

/** Reads the hook JSON on stdin, prints the agent-specific hook output. Never blocks a prompt. */
// Calibrated on a 4,500-skill library: real matches scored raw 15-38, small talk ~12. Override with SKILLROUTER_MIN_RAW.
export async function hint(agent: AgentId, input: string, minRaw = Number(process.env.SKILLROUTER_MIN_RAW ?? 14), k = 3): Promise<string> {
  let prompt = "";
  try { prompt = String(JSON.parse(input).prompt ?? "").trim(); } catch { /* not JSON */ }
  if (prompt.length < 20 || prompt.startsWith("/")) return formatHint(agent, "");
  let hits: Awaited<ReturnType<typeof search>> = [];
  // Gate: at least two distinct prompt terms matched, a decent BM25 sum, and close to the best hit.
  try { hits = (await search(prompt.slice(0, 1000), k)).filter((h) => h.matched >= 2 && h.raw >= minRaw && h.score >= 0.6); } catch { /* no index: stay silent */ }
  logUsage({ client: `hook/${agent}`, tool: "hint", hits: hits.map((h) => [h.skill.id, h.score]) }); // no prompt text
  if (!hits.length) return formatHint(agent, "");
  const lines = hits.map((h) => `- ${h.skill.id} (${h.score.toFixed(2)}): ${h.skill.description.slice(0, 140)}`).join("\n");
  return formatHint(agent,
    "Skill hints from skillrouter for this prompt. Use one only if it fits the task: invoke it if it is already in your skill list, otherwise load it with skillrouter read_skill.\n" + lines);
}
