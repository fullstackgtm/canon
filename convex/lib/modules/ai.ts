/**
 * A module's hosted AI step, run (docs/modules.md, "Hosted AI steps"): a call with `ai` in place of code. Its plan is
 * read as the caller (scope.ts snapshot), then: its budget, the prompt (modules/kernel/ai.ts), the caller's model
 * (convex/moduleAiActions.ts; Canon's test model on a local stack and in tests), the verbatim gate, and the answer
 * written through the declared update op as the caller, with a line on the doc's history. Every run leaves a receipt
 * (convex/moduleAi.ts), and one on Canon's model costs a credit once it is written. Nothing falls back: a run that
 * fails says why and writes nothing.
 */
import { ConvexError } from "convex/values";
import { internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import type { ActionCtx } from "../../_generated/server";
import { isDevAuthBypassEnabled } from "../../lib";
import { CREDIT_RATES, MICRO } from "../creditPacks";
import { AI_INPUT_DEFAULT, AI_PER_DAY_DEFAULT, aiPrompt, answerSchema, choiceValues, fakeAnswer, gateAnswer, textHash, type Dropped, type Gated } from "../../../modules/kernel/ai.ts";
import type { Intent, ReadValue } from "../../../modules/kernel/calls.ts";
import type { AiRun } from "./scope";
import { buildEvidenceRepairPrompt } from "../../../engine/src/evidence.ts";
import { superseded, moduleErrorMessage } from "./revision";

/**
 * Canon's test model answers (no network, $0): in tests (`MODULE_AI_MODEL=fake`), and on a local stack unless
 * `MODULE_AI_MODEL=live` asks for the person's own model there.
 */
export const fakeModel = () => process.env.MODULE_AI_MODEL === "fake" || (isDevAuthBypassEnabled() && process.env.MODULE_AI_MODEL !== "live");
export const FAKE_MODEL = "canon-test-model";

/** What an AI call returns to a page that asks: quotes kept and dropped, and which model wrote it, in words. */
export type AiValue = { kept: number; dropped: number; model: string };

const DAY_MS = 86_400_000;
const truncate = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);
/** The ids each read gave the step: a module doc's key, a Canon record's id. */
const readIds = (reads: Record<string, ReadValue>) => Object.entries(reads).map(([name, v]) => ({
  name, ids: (Array.isArray(v) ? v : v && typeof v === "object" && "key" in v ? [v] : []).flatMap((x) => {
    const r = x as Record<string, unknown>;
    return typeof r.key === "string" ? [r.key] : typeof r.id === "string" ? [r.id] : [];
  }).slice(0, 500),
}));
/** The history line of a run: what wrote it, what it kept, and the quotes it dropped. */
function historyNote(model: string, g: Gated): string {
  const quotes = `${g.kept} ${g.kept === 1 ? "quote" : "quotes"} found word for word`;
  const dropped = g.dropped.length ? `; dropped ${g.dropped.length}: ${g.dropped.slice(0, 3).map((d) => (d.quote ? `"${truncate(d.quote, 60)}" (${d.why})` : `${d.path} (${d.why})`)).join("; ")}${g.dropped.length > 3 ? "; …" : ""}` : "";
  return truncate(`Filled by AI (${model}): ${quotes}${dropped}.`, 500);
}

/**
 * Run the AI step of a call whose plan `reads` read, and write its answer through `apply` (the call's own apply, as
 * the caller, all or none). Returns what the call returns.
 */
export async function runAiStep(
  ctx: ActionCtx,
  a: { call: string; label: string; run: AiRun; reads: Record<string, ReadValue>; userId: string; returns: "none" | "value"; credits: boolean },
  apply: (intents: Intent[]) => Promise<{ writes: number; proposed: string[] } | null>,
): Promise<{ writes: number; proposed: string[]; value?: AiValue }> {
  const { run } = a;
  const reads = { ...a.reads };
  for (const [alias, source] of Object.entries(run.decl.sources ?? {})) {
    const doc = a.reads[source.read] as { data?: Record<string, unknown> } | null;
    const rows = doc?.data?.[source.field];
    if (!Array.isArray(rows) || rows.length > 500 || rows.some((r) => !r || typeof r !== "object" || typeof r.id !== "string")) throw new ConvexError("The retained evidence source is malformed.");
    reads[alias] = rows;
  }
  const { decl } = run;
  const orgId = run.orgId as Id<"organizations">;
  const userId = a.userId as Id<"users">;
  const started = Date.now();
  const perDay = decl.budget?.perDay ?? AI_PER_DAY_DEFAULT;
  const since = started - (started % DAY_MS);

  const choices = choiceValues(decl, reads);
  const prompt = aiPrompt({ module: run.module, label: a.label, ai: decl, reads, today: new Date(started).toISOString().slice(0, 10) });
  const most = decl.budget?.inputChars ?? AI_INPUT_DEFAULT;
  if (prompt.length > most) throw new ConvexError(`${a.label} would send ${prompt.length.toLocaleString("en-US")} characters to the model; it sends at most ${most.toLocaleString("en-US")}. It reads too much here to run.`);

  // The run is reserved against the budget before any model runs, so runs started together never pass it.
  const reserved = await ctx.runMutation(internal.moduleAi.reserve, {
    orgId, moduleId: run.moduleId, call: a.call, key: run.key, userId, since, perDay, promptVersion: textHash(decl.prompt), inputChars: prompt.length, reads: readIds(reads),
  });
  if (!reserved.id) throw new ConvexError(`You ran ${a.label} ${reserved.ran === 1 ? "once" : `${reserved.ran} times`} today, as often as it runs in a day. It runs again tomorrow (UTC).`);
  const receipt = reserved.id as Id<"moduleAiRuns">;
  const testing = fakeModel();
  let provider = testing ? "fake" : "unknown", model = testing ? FAKE_MODEL : "unknown";
  let gated: Gated = { data: {}, kept: 0, dropped: [] };
  let inputChars = 0;
  const fail = async (e: unknown): Promise<never> => {
    const error = moduleErrorMessage(e);
    await ctx.runMutation(internal.moduleAi.finish, { id: receipt, status: "failed", provider, model, inputChars, kept: gated.kept, dropped: cut(gated.dropped), error: truncate(error, 500), ms: Date.now() - started });
    throw e instanceof ConvexError ? e : new ConvexError(`${a.label}: ${error}`);
  };

  let applied: { writes: number; proposed: string[] };
  try {
    const ask = async (input: string) => {
      if (input.length > most) throw new ConvexError(`${a.label}: the evidence repair exceeds this run's input limit.`);
      inputChars += input.length;
      if (testing) return fakeAnswer(decl, run.schema, reads, choices);
      const answer = await ctx.runAction(internal.moduleAiActions.answer, { orgId, userId, label: a.label, prompt: input, schema: answerSchema(run.schema, choices), credits: a.credits && decl.credits !== false });
      provider = answer.provider; model = answer.model;
      return answer.raw;
    };
    gated = gateAnswer(decl, run.schema, await ask(prompt), reads, choices);
    if (decl.evidencePolicy && gated.kept < decl.evidencePolicy.minimum) {
      gated = gateAnswer(decl, run.schema, await ask(buildEvidenceRepairPrompt(prompt, gated.dropped.map((d) => d.quote))), reads, choices);
      if (gated.kept < decl.evidencePolicy.minimum) throw new ConvexError(`${a.label}: too few exact source quotes after one evidence repair. Research stopped rather than guess.`);
    }
    for (const [field, read] of Object.entries(decl.output.copy ?? {})) gated.data[field] = reads[read];
    if (decl.output.provenance) {
      gated.data[decl.output.provenance.model] = model;
      gated.data[decl.output.provenance.provider] = provider;
    }
    const collection = run.collection;
    // A field the answer leaves out is cleared, so an earlier run's quotes never stand beside this one's.
    const unset = decl.output.fields.filter((f) => gated.data[f] === undefined && run.schema.value[f]?.optional);
    const who = provider === "chatgpt" ? `${model} on your ChatGPT plan` : provider === "canon" ? `Canon's model, ${CREDIT_RATES.moduleAi} credit` : "Canon's test model, no AI ran";
    const result = await apply([
      { op: "op", name: decl.output.op, key: run.key, data: gated.data, ...(unset.length ? { unset } : {}), expect: [run.expect] },
      { op: "event", collection, key: run.key, note: historyNote(who, gated) },
    ]);
    if (!result) throw superseded();
    applied = result;
  } catch (e) {
    return fail(e);
  }
  // Canon's model is paid for once the answer is written: a run that failed or wrote nothing is free.
  let creditsMicro: number | undefined;
  if (provider === "canon" && applied.writes) {
    const ref = `module-ai:${orgId}:${run.moduleId}:${a.call}:${run.key}:${started}`;
    const amountMicro = CREDIT_RATES.moduleAi * MICRO;
    if (await ctx.runMutation(internal.credits.charge, { orgId, ref, amountMicro, note: `${run.module}: ${a.label}` })) {
      creditsMicro = amountMicro;
      await ctx.runAction(internal.credits.meterCharge, { ref, provider: "module-ai" }).catch((e) => console.warn(`module AI: Metronome report failed: ${e instanceof Error ? e.message.slice(0, 160) : e}`));
    } else console.warn(`module AI: ${run.moduleId} ${a.call} wrote ${run.key} but the workspace could not pay its credit`);
  }
  await ctx.runMutation(internal.moduleAi.finish, { id: receipt, status: "done", provider, model, inputChars, kept: gated.kept, dropped: cut(gated.dropped), ...(creditsMicro ? { creditsMicro } : {}), ms: Date.now() - started });
  const value: AiValue = { kept: gated.kept, dropped: gated.dropped.length, model };
  return { writes: applied.writes, proposed: applied.proposed, ...(a.returns === "value" ? { value } : {}) };
}

/** A receipt keeps at most 50 drops, each quote cut to 300 characters. */
const cut = (d: readonly Dropped[]) => d.slice(0, 50).map((x) => ({ ...x, quote: truncate(x.quote, 300) }));
