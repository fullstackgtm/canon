import { internal } from "../_generated/api";
import type { ActionCtx } from "../_generated/server";

/** Cross the runtime boundary before opening a DNS-pinned socket. */
export const integrationFetch = (ctx: Pick<ActionCtx, "runAction">, timeoutMs = 60_000): typeof fetch => async (input, init) => {
  const result = await ctx.runAction(internal.integrationHttp.request, {
    timeoutMs, url: String(input), method: init?.method === "POST" ? "POST" : "GET",
    headers: Object.fromEntries(new Headers(init?.headers).entries()),
    ...(typeof init?.body === "string" ? { body: init.body } : {}),
  });
  if (!result.ok) {
    const error = new Error("Integration request failed");
    if (result.error === "timeout") error.name = "TimeoutError";
    throw error;
  }
  return new Response([204, 205, 304].includes(result.status) ? null : result.body, { status: result.status, headers: result.headers });
};
