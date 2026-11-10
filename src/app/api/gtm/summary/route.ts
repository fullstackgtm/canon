import { api } from "../../../../../convex/_generated/api.js";
import { gtmApi } from "../_lib.ts";

export const dynamic = "force-dynamic";

export const GET = gtmApi(async ({ client }) => {
  const summary = await client.query(api.dashboard.summary, {});
  return Response.json({ summary });
});
