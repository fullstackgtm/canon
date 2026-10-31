import { v } from "convex/values";

/** What researching one record came to: a probe's sample row and every record's trace carry it. */
export const outcomeFields = {
  status: v.union(v.literal("answered"), v.literal("unknown"), v.literal("no_evidence"), v.literal("rejected"), v.literal("error")),
  value: v.optional(v.union(v.string(), v.number(), v.boolean())),
  quote: v.optional(v.string()),
  sourceUrl: v.optional(v.string()),
  reason: v.optional(v.string()),
  // Jev's read of the record from what the research read (classify and yes/no fields).
  jev: v.optional(v.object({ choice: v.string(), confidence: v.number(), probabilities: v.record(v.string(), v.number()) })),
  // Jev's read was proposed as the answer.
  inferred: v.optional(v.boolean()),
};

/** agentLoop.ts TraceStep. */
export const traceStepValidator = v.union(
  v.object({ kind: v.literal("read"), url: v.string(), ok: v.boolean(), snippet: v.optional(v.boolean()) }),
  v.object({ kind: v.literal("search"), query: v.string(), pages: v.number() }),
  v.object({ kind: v.literal("model"), action: v.union(v.literal("read"), v.literal("search"), v.literal("answer")) }),
);

/** One record's trace as the run slice reports it (researchAgents.progressRun). */
export const traceValidator = v.object({
  recordId: v.string(),
  label: v.string(),
  ...outcomeFields,
  steps: v.array(traceStepValidator),
  ms: v.number(),
  calls: v.number(),
  model: v.string(),
  promptVersion: v.string(),
});
