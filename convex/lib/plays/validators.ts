/** Validators for a deal's play (lib/plays/model.ts), shared by the schema and the play's functions. */
import { v } from "convex/values";
import { DEAL_ROLES } from "../objects/registry.ts";
import { CONFIDENCE, ITEM_KINDS, ORIGINS, PLAY_CHANNELS, STEP_STATES } from "./model.ts";

export const playChannel = v.union(...PLAY_CHANNELS.map((c) => v.literal(c)));
export const playItemKind = v.union(...ITEM_KINDS.map((k) => v.literal(k)));
export const playOrigin = v.union(...ORIGINS.map((o) => v.literal(o)));
export const playConfidence = v.union(...CONFIDENCE.map((c) => v.literal(c)));
export const playStepState = v.union(...STEP_STATES.map((s) => v.literal(s)));
export const dealRole = v.union(...DEAL_ROLES.map((r) => v.literal(r)));

export const draftReviewValidator = v.object({
  relevant: v.boolean(), pointOfView: v.optional(v.boolean()), surprising: v.optional(v.boolean()), wouldReply: v.boolean(), note: v.optional(v.string()),
  termConcessions: v.optional(v.array(v.object({ key: v.string(), label: v.string(), severity: v.union(v.literal("high"), v.literal("medium"), v.literal("low")) }))),
});
