/**
 * A workspace's hygiene.policy model (recipes/models.ts) as the engine's audit reads it: a GtmPolicy merged through
 * the engine's own mergePolicy, and the built-in rules it leaves on. Convex only: the engine CLI keeps reading its
 * fullstackgtm.config.json. Pure and free of Node imports, for queries and actions alike.
 */
import { defaultPolicy } from "../../engine/src/audit.ts";
import { mergePolicy } from "../../engine/src/policy.ts";
import { builtinAuditRules } from "../../engine/src/rules.ts";
import type { GtmAuditRule, GtmPolicy } from "../../engine/src/types.ts";
import type { HygieneModel } from "../../recipes/models.ts";

export const hygienePolicy = (model: HygieneModel, today?: string): GtmPolicy => mergePolicy(defaultPolicy(today), { policy: model.policy });

export const hygieneRules = (model: HygieneModel): GtmAuditRule[] => builtinAuditRules.filter((rule) => !model.disabledRules.includes(rule.id));
