import { v } from "convex/values";
import { query } from "./_generated/server";
import { INTEGRATIONS_AVAILABLE, integrationsAvailable } from "./lib/integrationsAvailable.ts";

export const status = query({
  args: {},
  returns: v.object(Object.fromEntries(Object.keys(INTEGRATIONS_AVAILABLE).map((key) => [key, v.boolean()]))),
  handler: async () => integrationsAvailable(),
});
