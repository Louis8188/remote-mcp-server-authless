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

async function getNotionEntries(): Promise<{raw: string}[]> {
  const res = await fetch('https://api.notion.com/v1/databases/' + NOTION_DB + '/query', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + NOTION_TOKEN, 'Content-Type': 'application/json', 'Notion-Version': '2022-06-28' },
    body: JSON.stringify({ page_size: 100 })
  });
  const data: any = await res.json();
  return (data.results || []).map((p: any) => ({
    raw: p.properties['Raw input']?.rich_text?.[0]?.text?.content || p.properties['Title']?.title?.[0]?.text?.content || ''
  }));
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
        const entries = await getNotionEntries();
        if (!entries.length) return { content: [{ type: "text", text: "No resources saved yet." }] };
        const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 1000,
            system: 'You are a multilingual knowledge assistant. Search all entries regardless of language. Reply in the same language as the query. Return the most relevant entries including their full original text.',
            messages: [{ role: 'user', content: 'Query: ' + query + '\n\nEntries:\n' + entries.map((e,i) => i+'. '+e.raw).join('\n') }]
          })
        });
        const aiData: any = await aiRes.json();
        return { content: [{ type: "text", text: aiData.content?.[0]?.text || 'No results found.' }] };
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
