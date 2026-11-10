import { ConvexError } from "convex/values";
import { z } from "zod";
import { api } from "../../../../../convex/_generated/api";
import { plainConvexClient, rateLimit, tooManyRequests } from "../../cli/_lib";

export const runtime = "nodejs";
const input = z.object({
  token: z.string().regex(/^[a-f0-9]{32}$/),
  email: z.string().max(254),
  role: z.string().max(100).optional(),
  teamSize: z.string().max(60).optional(),
  website: z.string().max(200).optional(),
});
export async function POST(request: Request) {
  if (!rateLimit(request, 5, 3600000)) return tooManyRequests();
  try {
    const parsed = input.safeParse(await request.json());
    if (!parsed.success)
      return Response.json(
        { error: "Enter a valid work email and research session." },
        { status: 400 },
      );
    await plainConvexClient().mutation(
      api.researchSessions.joinWaitlist,
      parsed.data,
    );
    return Response.json({ saved: true });
  } catch (error) {
    const message =
      error instanceof ConvexError
        ? String(error.data)
        : "Could not save your place. Try again.";
    return Response.json(
      { error: message },
      { status: /too many/i.test(message) ? 429 : 400 },
    );
  }
}
