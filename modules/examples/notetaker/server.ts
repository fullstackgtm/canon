import type { CallFunctions, ReadDoc } from "../../kernel/calls.ts";

/** Internal rule-preview facts supplied hypothetically, not a calendar, provider or feed contract. */
export type RuleEventFacts = {
  title: string;
  cancelled: boolean;
  declined: boolean;
  hasVideoLink: boolean;
  hosted: boolean;
  attendeeDomains: readonly string[];
  override?: "record" | "skip";
};
export type RecordingPreferences = {
  mode: "off" | "external" | "hosted" | "all" | "manual";
  includeDomains: readonly string[];
  excludeDomains: readonly string[];
  skipKeywords: readonly string[];
};
export type RecordingPolicyView = {
  internalRecording: boolean;
  internalDomains: readonly string[];
};
export type RecordingDecision = { decision: "record" | "skip" | "cancel"; reason: string };

const DEFAULT_PREFERENCES: RecordingPreferences = {
  mode: "off", includeDomains: [], excludeDomains: [], skipKeywords: [],
};
const normalized = (values: readonly string[]) => values.map((value) => value.trim().toLowerCase()).filter(Boolean);

/** Advisory rules only. Canon's private legal floor, consent and calendar verification remain action-time checks. */
export function decide(event: RuleEventFacts, prefs: RecordingPreferences, policyView: RecordingPolicyView): RecordingDecision {
  // Refine roadmap section 6 so cancellation survives a removed link or other vanished facts in a future plan.
  if (event.cancelled) return { decision: "cancel", reason: "meeting cancelled" };
  if (event.declined) return { decision: "skip", reason: "you declined" };
  if (!event.hasVideoLink) return { decision: "skip", reason: "no video link" };

  const attendees = event.attendeeDomains.map((domain) => domain.trim().toLowerCase());
  const internalDomains = new Set(normalized(policyView.internalDomains));
  const external = attendees.some((domain) => domain !== "" && !internalDomains.has(domain));
  if (!policyView.internalRecording) {
    if (!attendees.length || attendees.some((domain) => domain === "")) return { decision: "skip", reason: "unknown attendee domains" };
    if (!external) return { decision: "skip", reason: "internal meeting" };
  }
  if (event.override) return { decision: event.override, reason: event.override === "record" ? "you chose to record" : "you chose to skip" };
  if (prefs.mode === "off" || prefs.mode === "manual") return { decision: "skip", reason: "manual" };
  if (prefs.mode === "hosted" && !event.hosted) return { decision: "skip", reason: "you don't host it" };
  if (prefs.mode === "external" && !external) return { decision: "skip", reason: "no external attendees" };

  const included = normalized(prefs.includeDomains);
  if (included.length && !attendees.some((domain) => included.includes(domain))) return { decision: "skip", reason: "no included domain" };
  const excluded = normalized(prefs.excludeDomains);
  if (attendees.some((domain) => excluded.includes(domain))) return { decision: "skip", reason: "excluded domain" };
  const title = event.title.toLowerCase();
  if (normalized(prefs.skipKeywords).some((keyword) => title.includes(keyword))) return { decision: "skip", reason: "excluded title keyword" };
  return { decision: "record", reason: prefs.mode === "external" ? "external meeting" : prefs.mode === "hosted" ? "you host it" : "all meetings" };
}

export const calls: CallFunctions = {
  preferences(_ctx, reads) {
    const current = reads.current as ReadDoc | null;
    const policy = reads.policy as Array<Record<string, unknown>>;
    return { value: {
      mode: "off", includeDomains: [], excludeDomains: [], skipKeywords: [],
      ...current?.data,
      policy: policy[0],
    } };
  },
  previewDecision(ctx, reads) {
    const current = reads.current as ReadDoc | null;
    const policy = reads.policy as RecordingPolicyView[];
    const prefs = current ? current.data as RecordingPreferences : DEFAULT_PREFERENCES;
    return { value: {
      ...decide(ctx.args as RuleEventFacts, prefs, {
        internalRecording: policy[0].internalRecording,
        internalDomains: policy[0].internalDomains,
      }),
      advisoryOnly: true,
    } };
  },
  savePreferences(ctx, reads) {
    const current = reads.current as ReadDoc | null;
    const key = ctx.caller.userId;
    return {
      intents: [{
        op: "put", collection: "prefs", key,
        data: {
          user: key, mode: ctx.args.mode,
          includeDomains: ctx.args.includeDomains,
          excludeDomains: ctx.args.excludeDomains,
          skipKeywords: ctx.args.skipKeywords,
          ...(ctx.args.botName ? { botName: ctx.args.botName } : {}),
        },
        expect: [{ collection: "prefs", key, version: current?.version ?? null }],
        ...(current ? { require: { caller: "isOwner" as const } } : {}),
      }],
      value: { key },
    };
  },
};
