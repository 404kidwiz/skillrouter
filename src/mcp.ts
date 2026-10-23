import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { findSkill, logUsage, readSkill, search } from "./search.js";

/** Two tools, ~500 tokens of schema: the whole library behind one door. */
export async function serveMcp(): Promise<void> {
  const server = new McpServer({ name: "skillrouter", version: "0.1.0" });
  const client = () => {
    const info = server.server.getClientVersion();
    return info ? `${info.name}/${info.version}` : "unknown";
  };

  server.registerTool(
    "search_skills",
    {
      description: "Find skills for a task. Call this before non-trivial work when no preloaded skill clearly fits. Query = the task intent as one short phrase.",
      inputSchema: { query: z.string(), top_k: z.number().int().min(1).max(20).default(5) },
    },
    async ({ query, top_k }) => {
      const hits = await search(query, top_k);
      logUsage({ client: client(), tool: "search_skills", query, hits: hits.map((h) => [h.skill.id, h.score]) });
      const text = hits.length
        ? hits.map((h) => `- ${h.skill.id} (${h.score.toFixed(2)}): ${h.skill.description || "(no description)"}\n  path: ${h.skill.path}`).join("\n") +
          "\n\nLoad one with read_skill(id)."
        : "No matching skills.";
      return { content: [{ type: "text", text }] };
    },
  );

  server.registerTool(
    "read_skill",
    { description: "Load a skill's full SKILL.md instructions by id (from search_skills) or name.", inputSchema: { id: z.string() } },
    async ({ id }) => {
      const matches = findSkill(id);
      if (matches.length !== 1) {
        logUsage({ client: client(), tool: "read_skill", skill: id, found: false, candidates: matches.length });
        const text = matches.length ? "Ambiguous. Use one of:\n" + matches.map((m) => `- ${m.id} (${m.path})`).join("\n") : `Skill '${id}' not found.`;
        return { content: [{ type: "text", text }] };
      }
      logUsage({ client: client(), tool: "read_skill", skill: matches[0].id, found: true });
      return { content: [{ type: "text", text: `--- ${matches[0].id} @ ${matches[0].path} ---\n` + readSkill(matches[0]) }] };
    },
  );

  await server.connect(new StdioServerTransport());
}
