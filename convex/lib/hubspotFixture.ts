/**
 * Local stacks connect HubSpot with a `fixture:` private-app token instead of a real portal: every HubSpot request
 * the connection makes (connect, the scheduled sync, the import) is answered by the fake portal
 * (engine/src/sync/hubspotImport/testing/fakeHubspot.ts). `fixture:northwind` is the whole portal;
 * `fixture:northwind?forbid=calls,emails` answers those objects with a 403, as a token without their scope does;
 * `fixture:northwind?columns=industry` adds the industry columns field consolidation reads. `scale=500` adds that
 * many synthetic companies (with people, deals and engagements), `latency=250` delays each response, and `rate=100`
 * holds the token to 100 requests per 10 s, as HubSpot does: together they time a sync or an import. `modified=50`
 * marks the first 50 companies, people and deals modified a second ago, so each sync reads them as changed.
 * `cursor=id` pages the object lists by record id (FakePortal.idCursor), so a sync reads them in id ranges.
 * The seeded demo connection never reaches HubSpot either. Anywhere demo data is off (dev and production), a
 * fixture token is an ordinary token and HubSpot refuses it.
 */
import { isDevAuthBypassEnabled } from "../lib";
import { fakeHubspotFetch, northwindPortal, scaledPortal, touchRecords } from "../../engine/src/sync/hubspotImport/testing/fakeHubspot.ts";

const PREFIX = "fixture:northwind";

/** The seeded demo connection's token (convex/devSeed.ts): it names no portal, so a local stack answers it with a 401 itself. */
const DEMO_TOKEN = "demo-access-token";

export function fixtureFetch(token: string): typeof fetch | undefined {
  if (!isDevAuthBypassEnabled()) return undefined;
  if (token === DEMO_TOKEN) return (async () => new Response(JSON.stringify({ status: "error", message: "The demo connection has no portal" }), { status: 401 })) as unknown as typeof fetch;
  if (!token.startsWith(PREFIX)) return undefined;
  const params = new URLSearchParams(token.slice(PREFIX.length).replace(/^\?/, ""));
  const list = (name: string) => (params.get(name) ?? "").split(",").filter(Boolean);
  const opts = { forbidden: list("forbid"), columns: list("columns") };
  const scale = Number(params.get("scale") ?? 0);
  const rate = Number(params.get("rate") ?? 0);
  const base = scale > 0 ? scaledPortal(Math.min(scale, 20_000), opts) : northwindPortal(opts);
  const portal = params.get("cursor") === "id" ? { ...base, idCursor: true } : base;
  const modified = Number(params.get("modified") ?? 0);
  // A second ago: a sync's window ends when it starts, and this is called just before.
  return fakeHubspotFetch(modified > 0 ? touchRecords(portal, modified, new Date(Date.now() - 1000)) : portal, {
    latencyMs: Number(params.get("latency") ?? 0), ...(rate > 0 ? { rateLimit: { max: rate, intervalMs: 10_000 } } : {}),
  });
}
