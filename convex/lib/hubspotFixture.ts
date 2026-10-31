/**
 * Local stacks connect HubSpot with a `fixture:` private-app token instead of a real portal: every HubSpot request
 * the connection makes (connect, the scheduled sync, the import) is answered by the fake portal
 * (engine/src/sync/hubspotImport/testing/fakeHubspot.ts). `fixture:northwind` is the whole portal;
 * `fixture:northwind?forbid=calls,emails` answers those objects with a 403, as a token without their scope does.
 * The seeded demo connection never reaches HubSpot either. Anywhere demo data is off (dev and production), a
 * fixture token is an ordinary token and HubSpot refuses it.
 */
import { isDevAuthBypassEnabled } from "../lib";
import { fakeHubspotFetch, northwindPortal } from "../../engine/src/sync/hubspotImport/testing/fakeHubspot.ts";

const PREFIX = "fixture:northwind";

/** The seeded demo connection's token (convex/devSeed.ts): it names no portal, so a local stack answers it with a 401 itself. */
const DEMO_TOKEN = "demo-access-token";

export function fixtureFetch(token: string): typeof fetch | undefined {
  if (!isDevAuthBypassEnabled()) return undefined;
  if (token === DEMO_TOKEN) return (async () => new Response(JSON.stringify({ status: "error", message: "The demo connection has no portal" }), { status: 401 })) as unknown as typeof fetch;
  if (!token.startsWith(PREFIX)) return undefined;
  const forbid = new URLSearchParams(token.slice(PREFIX.length).replace(/^\?/, "")).get("forbid");
  return fakeHubspotFetch(northwindPortal({ forbidden: forbid ? forbid.split(",").filter(Boolean) : [] }));
}
