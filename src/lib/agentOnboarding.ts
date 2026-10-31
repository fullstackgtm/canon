/**
 * Copy for agent-driven onboarding: how to connect an agent to Canon's hosted
 * MCP server, and the prompts that set a workspace up from that agent. Tool
 * names match src/app/mcp/_canonTools.ts and _canonJobTools.ts.
 */

export const mcpUrl = (origin: string) => `${origin}/mcp`;

export type AgentClient = { id: string; label: string; steps: { text: string; code?: string }[] };

export function agentClients(origin: string): AgentClient[] {
  const url = mcpUrl(origin);
  return [
    {
      id: "claude-code",
      label: "Claude Code",
      steps: [
        { text: "Add Canon in your terminal:", code: `claude mcp add --transport http canon ${url}` },
        { text: "Start claude, run /mcp, pick canon and sign in in the browser." },
      ],
    },
    {
      id: "codex",
      label: "Codex",
      steps: [
        { text: "Add Canon and sign in:", code: `codex mcp add canon --url ${url}\ncodex mcp login canon` },
      ],
    },
    {
      id: "cursor",
      label: "Cursor",
      steps: [
        { text: "Add to ~/.cursor/mcp.json:", code: JSON.stringify({ mcpServers: { canon: { url } } }, null, 2) },
        { text: "Open Settings → MCP and click Connect next to canon." },
      ],
    },
    {
      id: "claude-app",
      label: "Claude app",
      steps: [
        { text: "Settings → Connectors → Add custom connector, with this URL:", code: url },
        { text: "Click Connect and sign in." },
      ],
    },
  ];
}

const domainLine = (domain: string | null) =>
  domain ? `our company domain, ${domain}` : "our company domain (ask me for it)";

/** The one prompt that connects the agent, confirms the ICP, adds sample accounts and starts research. */
export function starterPrompt(origin: string, domain: string | null): string {
  const url = mcpUrl(origin);
  return `Set me up on Canon, our CRM at ${origin}. Work through these steps in order and stop where I need to confirm something.

1. Connect. If you don't have Canon's tools yet (canon_whoami), add Canon's MCP server: streamable HTTP at ${url}, OAuth sign-in.
   - Claude Code: run \`claude mcp add --transport http canon ${url}\`, then tell me to run /mcp and sign in.
   - Codex: run \`codex mcp add canon --url ${url}\` and \`codex mcp login canon\`.
   - Anything else: add an MCP server named canon with that URL.
   Then call canon_whoami to confirm you're signed in as me, and get_docs to learn how Canon works.

2. ICP. Check canon_icp (action "tree") and canon_research (action "status"). If nothing has been researched yet, start research on ${domainLine(domain)} with canon_research "start", and poll canon_research "session" until the ICP is ready. Summarize it for me: the companies we sell to (industry, size, region), the buyer roles, and what disqualifies an account. Ask me to confirm or correct it. Then claim the research (canon_research "claim") so its market is imported, and save the confirmed ICP with canon_icp: "import_research" saves the research's ICP, and "update" with its query line corrects it. If I name narrower targets or the people to reach, add them as segments and personas with canon_icp "add_node".

3. Sample accounts. Show me the 10 accounts that fit the ICP best (canon_list_records for accounts sorted by fit, highest first), with one line on why each fits. If I name accounts that are missing, add them with canon_upsert_accounts.

4. Research. Propose 2-3 account research questions and 1-2 contact research questions that would tell us which accounts to prioritize and how to approach them. Once I approve, create each with canon_ai_fields "create" (entityType "account" or "contact") and start it on the sample accounts and their contacts with canon_ai_fields "run". Runs use my ChatGPT plan: if one fails because ChatGPT isn't connected, send me to Integrations → ChatGPT in Canon to sign in. Tell me what's running and when to check back.

Ask me before any write I haven't approved. Don't invent facts; anything you add to Canon needs a source.`;
}

/** Follow-up prompts for the agent-driven setup steps, once an agent is connected. */
export function stepPrompt(stepId: string, domain: string | null): string | null {
  if (stepId === "review_icp") {
    return `Using Canon, help me confirm our ICP. Check canon_icp "tree" and canon_research "status". If nothing has been researched, start research on ${domainLine(domain)} with canon_research "start" and poll "session" until it's ready. Summarize the ICP (companies we sell to, buyer roles, disqualifiers), ask me to confirm or correct it, then claim the research and save the confirmed ICP with canon_icp ("import_research", then "update" with its query line). Add any narrower targets or people to reach as segments and personas with canon_icp "add_node".`;
  }
  if (stepId === "research_accounts") {
    return `Using Canon, show me the 10 accounts that fit our ICP best (canon_list_records for accounts sorted by fit, highest first) with one line on why each fits. Then propose 2-3 account research questions and 1-2 contact research questions. Once I approve, create them with canon_ai_fields "create" (entityType "account" or "contact") and run them on those accounts and their contacts with canon_ai_fields "run". Ask before any write I haven't approved.`;
  }
  return null;
}
