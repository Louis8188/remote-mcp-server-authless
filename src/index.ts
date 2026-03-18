import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";

const NOTION_TOKEN = 'ntn_b12552877176FqqJMCSt6hyUCkofPU5McVESYo0zeC2fTb';
const NOTION_DB = '32504ad22ba580639c91c481bc05548e';
const ANTHROPIC_KEY = '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';

async function saveToNotion(rawText: string): Promise<boolean> {
  const title = rawText.length > 100 ? rawText.slice(0, 100) + '...' : rawText;
  const res = await fetch('https://api.notion.com/v1/pages', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + NOTION_TOKEN, 'Content-Type': 'application/json', 'Notion-Version': '2022-06-28' },
    body: JSON.stringify({
      parent: { database_id: NOTION_DB },
      properties: {
        'Title': { title: [{ text: { content: title } }] },
        'Raw input': { rich_text: [{ text: { content: rawText.slice(0, 2000) } }] }
      }
    })
  });
  return res.ok;
}

async function getNotionEntries(): Promise<string[]> {
  const res = await fetch('https://api.notion.com/v1/databases/' + NOTION_DB + '/query', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + NOTION_TOKEN, 'Content-Type': 'application/json', 'Notion-Version': '2022-06-28' },
    body: JSON.stringify({ page_size: 100 })
  });
  const data: any = await res.json();
  if (!data.results) return [];
  return data.results
    .map((p: any) => {
      const raw = p.properties?.['Raw input']?.rich_text?.[0]?.text?.content;
      const title = p.properties?.['Title']?.title?.[0]?.text?.content;
      return raw || title || '';
    })
    .filter((s: string) => s.length > 0);
}

export class MyMCP extends McpAgent {
  server = new McpServer({ name: "Resource Brain", version: "1.0.0" });

  async init() {
    this.server.tool(
      "save_resource",
      { raw_text: z.string().describe("The exact text to save verbatim, in the user's original language. Never modify or summarize.") },
      async ({ raw_text }) => {
        const ok = await saveToNotion('[Claude chat] ' + raw_text);
        return { content: [{ type: "text", text: ok ? "✓ Saved to your Resource Brain." : "⚠ Save failed — check Notion connection." }] };
      }
    );

    this.server.tool(
      "search_resources",
      { query: z.string().describe("The search query or question, in any language.") },
      async ({ query }) => {
        try {
          const entries = await getNotionEntries();
          if (!entries.length) {
            return { content: [{ type: "text", text: "No resources saved yet in your Resource Brain." }] };
          }

          const entriesText = entries.map((e, i) => `[${i + 1}] ${e}`).join('\n\n');

          const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-api-key': ANTHROPIC_KEY,
              'anthropic-version': '2023-06-01'
            },
            body: JSON.stringify({
              model: 'claude-haiku-4-5-20251001',
              max_tokens: 2000,
              messages: [{
                role: 'user',
                content: `You are a multilingual knowledge assistant. The user has these saved resource notes:\n\n${entriesText}\n\nUser query: ${query}\n\nFind all relevant entries. Reply in the same language as the query. For each match, show the full original text. If nothing matches, say so clearly.`
              }]
            })
          });

          const aiData: any = await aiRes.json();
          const answer = aiData?.content?.[0]?.text;

          if (!answer) {
            // Fallback: simple keyword search if AI fails
            const lowerQuery = query.toLowerCase();
            const matches = entries.filter(e => e.toLowerCase().includes(lowerQuery));
            if (matches.length === 0) return { content: [{ type: "text", text: `No entries found matching "${query}". Total entries: ${entries.length}.` }] };
            return { content: [{ type: "text", text: `Found ${matches.length} matching entries:\n\n${matches.join('\n\n---\n\n')}` }] };
          }

          return { content: [{ type: "text", text: answer }] };
        } catch (e: any) {
          return { content: [{ type: "text", text: `Search error: ${e.message}` }] };
        }
      }
    );
  }
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);
    if (url.pathname === "/mcp") {
      return MyMCP.serve("/mcp").fetch(request, env, ctx);
    }
    return new Response("Not found", { status: 404 });
  },
};
