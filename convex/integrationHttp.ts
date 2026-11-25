"use node";

import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { publicHttpGet, publicHttpPost, type PublicLookup, type PublicRequestHop } from "../engine/src/publicHttp.ts";
import { integrationUrl } from "./lib/integrationUrl.ts";
import { allowLoopbackWebhooks } from "./lib/recordWebhooks.ts";
import { webhookUrlProblem } from "./lib/agents/slack.ts";

export function pinnedIntegrationFetch(deps: { lookup?: PublicLookup; requestHop?: PublicRequestHop; timeoutMs?: number } = {}): typeof fetch {
  return async (input, init) => {
    const url = String(input);
    const slack = webhookUrlProblem(url, allowLoopbackWebhooks()) === null;
    if (!slack) integrationUrl(url);
    const options = { ...deps, headers: Object.fromEntries(new Headers(init?.headers).entries()), timeoutMs: deps.timeoutMs ?? 60_000, maxRedirects: 0 };
    try {
      const res = init?.method === "POST"
        ? await publicHttpPost(url, { ...options, body: typeof init.body === "string" ? init.body : undefined, allowLoopback: slack && allowLoopbackWebhooks() })
        : await publicHttpGet(url, options);
      return new Response([204, 205, 304].includes(res.status) ? null : new Uint8Array(res.body).buffer, { status: res.status, headers: res.headers });
    } catch (cause) {
      const error = new Error("Integration request failed");
      if (cause instanceof Error && cause.name === "TimeoutError") error.name = "TimeoutError";
      throw error;
    }
  };
}

export const request = internalAction({
  args: { url: v.string(), method: v.union(v.literal("GET"), v.literal("POST")), headers: v.record(v.string(), v.string()), body: v.optional(v.string()), timeoutMs: v.optional(v.number()) },
  handler: async (_ctx, args): Promise<
    { ok: true; status: number; headers: Record<string, string>; body: string } | { ok: false; error: "timeout" | "network" }
  > => {
    try {
      const response = await pinnedIntegrationFetch({ timeoutMs: Math.max(1, Math.min(args.timeoutMs ?? 60_000, 60_000)) })(args.url, args);
      return { ok: true, status: response.status, headers: Object.fromEntries(response.headers.entries()), body: await response.text() };
    } catch (cause) {
      return { ok: false, error: cause instanceof Error && cause.name === "TimeoutError" ? "timeout" : "network" };
    }
  },
});
