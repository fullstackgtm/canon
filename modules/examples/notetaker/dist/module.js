var DEFAULT_PREFERENCES = {
  mode: "off",
  includeDomains: [],
  excludeDomains: [],
  skipKeywords: []
};
var normalized = (values) => values.map((value) => value.trim().toLowerCase()).filter(Boolean);
function decide(event, prefs, policyView) {
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
var calls = {
  preferences(_ctx, reads) {
    const current = reads.current;
    const policy = reads.policy;
    return { value: {
      mode: "off",
      includeDomains: [],
      excludeDomains: [],
      skipKeywords: [],
      ...current?.data,
      policy: policy[0]
    } };
  },
  previewDecision(ctx, reads) {
    const current = reads.current;
    const policy = reads.policy;
    const prefs = current ? current.data : DEFAULT_PREFERENCES;
    return { value: {
      ...decide(ctx.args, prefs, {
        internalRecording: policy[0].internalRecording,
        internalDomains: policy[0].internalDomains
      }),
      advisoryOnly: true
    } };
  },
  savePreferences(ctx, reads) {
    const current = reads.current;
    const key = ctx.caller.userId;
    return {
      intents: [{
        op: "put",
        collection: "prefs",
        key,
        data: {
          user: key,
          mode: ctx.args.mode,
          includeDomains: ctx.args.includeDomains,
          excludeDomains: ctx.args.excludeDomains,
          skipKeywords: ctx.args.skipKeywords,
          ...ctx.args.botName ? { botName: ctx.args.botName } : {}
        },
        expect: [{ collection: "prefs", key, version: current?.version ?? null }],
        ...current ? { require: { caller: "isOwner" } } : {}
      }],
      value: { key }
    };
  }
};
export {
  calls,
  decide
};
