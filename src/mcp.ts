import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createHash } from "node:crypto";
import { z } from "zod";
import { findSkill, logUsage, readSkill } from "./search.js";
import { routeSearch, formatSearch } from "./routing.js";

/** Two tools, ~500 tokens of schema: the whole library behind one door. */
export async function serveMcp(): Promise<void> {
  const server = new McpServer({ name: "skillrouter", version: JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version });
  const context = () => ({ agent: process.env.SKILLROUTER_AGENT,
    session: process.env.SKILLROUTER_SESSION_ID ? createHash("sha256").update(process.env.SKILLROUTER_SESSION_ID).digest("hex") : undefined });
  const client = () => {
    const info = server.server.getClientVersion();
    return info ? `${info.name}/${info.version}` : "unknown";
  };

  server.registerTool(
    "search_skills",
    {
      description: "Find skills for a task. Call this before non-trivial work when no preloaded skill clearly fits. Query = the task intent as one short phrase.",
      inputSchema: { query: z.string(), top_k: z.number().int().min(1).max(20).default(5), exploratory: z.boolean().default(false).describe("Include weaker candidates, explicitly labeled; default returns only strong matches") },
    },
    async ({ query, top_k, exploratory }) => {
      let result: Awaited<ReturnType<typeof routeSearch>>;
      try { result = await routeSearch(query, { k: top_k, exploratory }); } // a preloaded skill wins over its copies
      catch {
        logUsage({ ...context(), client: client(), tool: "search_skills", reason: "index_error" });
        return { isError: true, content: [{ type: "text", text: "Index unavailable. Run skillrouter index." }] };
      }
      logUsage({ ...context(), client: client(), tool: "search_skills", query, exploratory, sem: result.semantic, hits: result.hits.map((h) => [h.skill.id, h.score]) });
      const text = formatSearch(result);
      return { content: [{ type: "text", text }] };
    },
  );

  server.registerTool(
    "read_skill",
    { description: "Load a skill's full SKILL.md instructions by id (from search_skills) or name.", inputSchema: { id: z.string(), hint_id: z.string().optional().describe("Copy the hint_id from the prompt hint when loading its suggested skill") } },
    async ({ id, hint_id }) => {
      let matches: ReturnType<typeof findSkill>;
      try { matches = findSkill(id); }
      catch {
        logUsage({ ...context(), client: client(), tool: "read_skill", hint_id, skill: id, found: false, reason: "index_error" });
        return { isError: true, content: [{ type: "text", text: "Index unavailable. Run skillrouter index." }] };
      }
      if (matches.length !== 1) {
        logUsage({ ...context(), client: client(), tool: "read_skill", hint_id, skill: id, found: false, candidates: matches.length });
        const text = matches.length ? "Ambiguous. Use one of:\n" + matches.map((m) => `- ${m.id} (${m.path})`).join("\n") : `Skill '${id}' not found.`;
        return { content: [{ type: "text", text }] };
      }
      try {
        const text = readSkill(matches[0]);
        logUsage({ ...context(), client: client(), tool: "read_skill", hint_id, skill: matches[0].id, found: true });
        return { content: [{ type: "text", text: `--- ${matches[0].id} @ ${matches[0].path} ---\n` + text }] };
      } catch {
        logUsage({ ...context(), client: client(), tool: "read_skill", hint_id, skill: matches[0].id, found: false, reason: "read_error" });
        return { isError: true, content: [{ type: "text", text: "Skill could not be loaded. Rebuild the index if it moved or was removed." }] };
      }
    },
  );

  await server.connect(new StdioServerTransport());
}
