import { siteUrl } from "../../lib/siteUrl.ts";
import { crmOpsLeaderboard } from "../../data/crmOpsLeaderboard.ts";

/**
 * Remote MCP tool implementations — READ-ONLY, and an exact mirror of the
 * Tier-1 public surface (/api/public/*). Same data source, no duplication:
 * the leaderboard is the committed artifact from
 * scripts/generate-agent-leaderboard.ts. No tenant data, no writes — an MCP
 * client authenticated via Clerk OAuth still only sees what a
 * self-registered agent sees.
 *
 * Kept as plain functions (no MCP/Clerk imports) so tests exercise them
 * directly against fixtures.
 */

export function getLeaderboardText(): string {
  return JSON.stringify(crmOpsLeaderboard, null, 2);
}

/** llms.txt-style product summary. Keep every claim factual and modest. */
export function getDocsText(): string {
  return `# CanonCRM

A CRM that fills itself and stays clean. When an organization signs up,
CanonCRM reads its website, works out who it sells to, and fills the CRM
with matching accounts and contacts. After that, agents, imports and
enrichment tools propose changes; a person or a calibrated rule approves
them, and every field keeps the source it came from. CanonCRM never
writes to a connected CRM without an explicitly approved plan.

## Agent access (this server's surface)

- CRM-Ops Bench leaderboard: the get_leaderboard tool here, or
  GET ${siteUrl()}/api/public/leaderboard with a
  self-registered agent token (POST /api/agents/register).
- Signed-in connections (OAuth, or a paired CLI token) also get canon_*
  tools that read and write the user's organization with that user's
  rights. Self-registered agent tokens never do. Details:
  ${siteUrl()}/auth.md

## Links

- Website and app: ${siteUrl()}
- Auth guide: ${siteUrl()}/auth.md
`;
}
