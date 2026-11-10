/** A saved ICP's spec (convex/lib/icps.ts), as a validator the schema, Canon's functions and modules share. */
import { v, type Infer } from "convex/values";

const strings = v.array(v.string());

export const icpExcludeValidator = v.object({ industries: strings, countries: strings, titles: strings });
/**
 * An accepted AI-field answer the ICP requires (accounts only): one of `values`
 * (option keys for a choice field, "true"/"false" for yes/no, exact text
 * otherwise), or a number in [min, max]. An account without an answer is outside.
 */
export const icpCustomCriterionValidator = v.object({
  slug: v.string(),
  values: v.optional(strings),
  min: v.optional(v.number()),
  max: v.optional(v.number()),
});

export const icpSpecValidator = v.object({
  market: v.object({ industries: strings, employeeBands: strings, countries: strings }),
  /** `countries` is where the buyer is located; the market's `countries` is where the company is. */
  persona: v.object({ levels: strings, departments: strings, titles: strings, countries: v.optional(strings) }),
  exclude: icpExcludeValidator,
  custom: v.optional(v.array(icpCustomCriterionValidator)),
});

/** Values a fill skips and fit scoring sinks to 0. `industries` and `countries` use the market's vocabularies. */
export type IcpExclude = Infer<typeof icpExcludeValidator>;
export type IcpSpec = Infer<typeof icpSpecValidator>;
export type IcpCustomCriterion = Infer<typeof icpCustomCriterionValidator>;
