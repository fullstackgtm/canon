import type { FunctionArgs, HttpRouter } from "convex/server";
import { httpAction } from "../../_generated/server";
import { internal } from "../../_generated/api";
import { verifyPiCallback } from "../piRuntimeTokens";

export function registerPiRoute(http: HttpRouter) {
  http.route({
    path: "/pi-runtime", method: "POST",
    handler: httpAction(async (ctx, request) => {
      const body = await request.text();
      if (body.length > 100_000) return new Response("Payload too large", { status: 413 });
      if (!await verifyPiCallback(process.env.CANON_PI_SECRET ?? "", body, request.headers.get("X-Canon-Pi-Time"), request.headers.get("X-Canon-Pi-Signature"))) return new Response("Unauthorized", { status: 401 });
      let input: { runId: string; operation: string; data: Record<string, unknown> };
      try { input = JSON.parse(body); } catch { return new Response("Invalid JSON", { status: 400 }); }
      if (!input || typeof input.runId !== "string" || !input.data || typeof input.data !== "object" || Array.isArray(input.data)) return new Response("Invalid callback", { status: 400 });
      const args = { ...input.data, runId: input.runId };
      try {
        let result: unknown;
        switch (input.operation) {
          case "next": result = await ctx.runAction(internal.piResearchActions.next, args as FunctionArgs<typeof internal.piResearchActions.next>); break;
          case "effect": result = await ctx.runAction(internal.piResearchActions.effect, args as FunctionArgs<typeof internal.piResearchActions.effect>); break;
          case "finish": result = await ctx.runAction(internal.piResearchActions.finish, args as FunctionArgs<typeof internal.piResearchActions.finish>); break;
          case "status": result = await ctx.runMutation(internal.piResearch.status, args as FunctionArgs<typeof internal.piResearch.status>); break;
          case "fail": result = await ctx.runMutation(internal.piResearch.fail, args as FunctionArgs<typeof internal.piResearch.fail>); break;
          default: return new Response("Unknown callback", { status: 400 });
        }
        return Response.json(result);
      } catch {
        return Response.json({ error: "Canon refused this Pi callback" }, { status: 409 });
      }
    }),
  });
}
