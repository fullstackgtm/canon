import { api } from "../../../../../convex/_generated/api";
import { plainConvexClient } from "../../cli/_lib.ts";

export const dynamic = "force-dynamic";

export async function GET() {
  const examples = await plainConvexClient().query(api.researchSessions.examples, {});
  return Response.json(examples);
}
