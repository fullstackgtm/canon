import { verifyPiService } from "../../../convex/lib/piRuntimeTokens.ts";

type Namespace = { get(scriptName: string): Fetcher };
type Env = { CANON_PI_SECRET: string; ORGS?: Namespace; [binding: `ORG_${string}`]: Fetcher };

// Local wrangler rejects dispatch_namespaces bindings ("needs to be run remotely"), so service bindings stand in for `env.ORGS.get(name)`.
const namespace = (env: Env): Namespace => env.ORGS ?? { get: (name) => {
  const fetcher = env[`ORG_${name.replace(/^canon-org-/, "").toUpperCase()}`];
  if (!fetcher) throw new Error("Worker not found");
  return fetcher;
} };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const org = url.pathname.match(/^\/orgs\/([a-z0-9-]{1,40})\//)?.[1];
    if (!org) return new Response("Not found", { status: 404 });
    if (!await verifyPiService(env.CANON_PI_SECRET, request.method, url.pathname + url.search, request.headers)) return new Response("Unauthorized", { status: 401 });
    try { return await namespace(env).get(`canon-org-${org}`).fetch(request); }
    catch { return new Response("Unknown org", { status: 404 }); }
  },
};
