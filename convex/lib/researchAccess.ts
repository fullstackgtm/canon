import { z } from "zod";
import { SESSION_CACHE_MS } from "./researchPipeline.ts";

export function researchAvailable(
  session: {
    createdAt: number;
    waitlistedAt?: number;
    claimedByOrgId?: unknown;
  },
  now = Date.now(),
) {
  return Boolean(
    session.waitlistedAt ||
      session.claimedByOrgId ||
      session.createdAt + SESSION_CACHE_MS > now,
  );
}
export const waitlistInput = z.object({
  email: z
    .email()
    .max(254)
    .transform((email) => email.toLowerCase())
    .refine(
      (email) =>
        !new Set([
          "gmail.com",
          "googlemail.com",
          "yahoo.com",
          "hotmail.com",
          "outlook.com",
          "icloud.com",
          "aol.com",
          "proton.me",
          "protonmail.com",
        ]).has(email.split("@")[1]),
      "Use your work email.",
    ),
  role: z.string().trim().max(100).optional(),
  teamSize: z.string().trim().max(60).optional(),
});

export function researchPreparation(session: { _id: string; createdAt: number; preparationKey?: string; preparationExpiresAt?: number }) {
  return { sessionId: session.preparationKey ?? session._id, expiresAt: session.preparationExpiresAt ?? session.createdAt + SESSION_CACHE_MS };
}
