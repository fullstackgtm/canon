import type { CallFunctions, ReadValue } from "../../kernel/calls.ts";

type Row = Record<string, unknown>;
const record = (v: unknown): Row => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Row : {};
const list = (v: unknown): Row[] => Array.isArray(v) ? v.map(record) : [];
const text = (v: unknown): string => v === null || v === undefined ? "" : String(v);
const number = (v: unknown): number => typeof v === "number" && Number.isFinite(v) ? v : 0;
const date = (v: unknown): string => typeof v === "number" && Number.isFinite(v) ? new Date(v).toISOString().replace("T", " ").slice(0, 16) + " UTC" : "";
const rows = (v: ReadValue): Row[] => list(v);
const label = (v: unknown, field: Row): string => {
  if (typeof v === "boolean") return v ? "Yes" : "No";
  return text(list(field.options).find((o) => o.key === v)?.label ?? v);
};
const percent = (v: unknown) => `${Math.round(number(v) * 100)}%`;

export function fieldPage(field: Row | undefined) {
  if (!field) return { found: false, title: "Field not found", details: [], options: [], canRun: false, canEditGate: false, canRefresh: false };
  const latest = record(field.latestRun);
  const estimate = record(field.refreshEstimate);
  const cadence = text(field.refreshCadence);
  return {
    ...field, found: true, slug: text(field.id), title: text(field.label),
    threshold: field.autoAccept ?? 0.8, cadence: cadence || "weekly",
    canRun: field.agentStatus === "active" && latest.status !== "running",
    scope: field.entity === "contact"
      ? "Research up to 100 unanswered people. Choose all contacts, a saved view, or selected record ids."
      : "Research up to 100 unanswered best-fit accounts. Optional filters narrow the account scope. Records tried in the last 30 days are skipped.",
    details: [
      { label: "Attribute", value: text(field.attribute) },
      { label: "Question", value: text(field.question) },
      { label: "Owner", path: "/dashboard/agents", value: `${text(field.owner) || "Unknown"} · ${text(field.agentStatus)}${field.agentMessage ? ` · ${text(field.agentMessage)}` : ""}` },
      { label: "Review", path: "/dashboard/facts", value: field.autoAccept === null ? "Manual review in Fact Review" : `Auto-accept when Jev scores at least ${number(field.autoAccept).toFixed(2)}; other answers wait in Fact Review` },
      { label: "Refresh", value: cadence ? `${cadence}; next ${date(field.refreshNextAt)}` : "Off" },
      ...(field.refreshHold ? [{ label: "Refresh paused", value: `${text(field.refreshHold)}${field.refreshNextAt ? `; checked again ${date(field.refreshNextAt)}` : ""}` }] : []),
      ...(cadence ? [{ label: "Refresh cost", value: `Re-asks answers older than ${cadence === "weekly" ? 7 : 30} days, up to ${number(estimate.cap)} per refresh on the owner's ChatGPT plan. Canon pays up to $${number(estimate.jevUsdMax).toFixed(4)} for Jev checks${number(estimate.extractionCallsMax) ? ` and ${number(estimate.extractionCallsMax)} extraction requests, estimated $${number(estimate.extractionUsdMax).toFixed(4)}` : ""}.` }] : []),
      ...(field.recipe ? [{ label: "Customization", path: "/dashboard/customization", value: `From ${text(record(field.recipe).title)} · v${number(record(field.recipe).version)}` }] : []),
    ],
    thresholds: [0.6, 0.7, 0.8, 0.9, 0.95].map((value) => ({ value, label: value.toFixed(2) })),
    options: list(field.options).map((o) => ({ key: text(o.key), label: text(o.label), description: text(o.description) })),
  };
}

export function runPage(field: Row | undefined, run: Row | undefined, traces: Row[]) {
  if (!field || !run) return { found: false, title: "Research run unavailable", summary: [], sample: [], picks: [], traces: [], bands: "", verdict: "Run not found, or not yours to see." };
  const verdict = record(run.verdict);
  const jev = record(verdict.jev);
  const bands = record(jev.bands);
  const credits = record(run.credits);
  const stop = record(run.stop);
  const pct = number(run.planned) ? Math.round((number(run.done) + number(run.errors)) / number(run.planned) * 100) : 0;
  const verdicts: Record<string, string> = {
    pending: "Trying it on a sample", too_few: "Too few records finished to judge", ready: "Ready", mixed: "Mixed; read the misses before a full run",
    undecidable: "Few pages state this outright", doesnt_split: "Doesn't split on this scope",
  };
  const top = record(verdict.top);
  const stepText = (s: Row) => s.kind === "search" ? `Search: ${text(s.query)} · ${number(s.pages)} results`
    : s.kind === "model" ? `Model: ${text(s.action)}`
    : `${s.ok ? s.snippet ? "Search result" : "Read" : "Couldn't read"}: ${text(s.url)}`;
  return {
    found: true, id: text(run.id), canStop: run.status === "running", title: `${text(field.label)} · ${text(run.status)}`,
    summary: [
      { label: "Status", value: `${text(run.status)}${run.scheduled ? " · scheduled refresh" : ""}${run.probe ? ` · sample of ${number(run.planned)}` : ""}` },
      { label: "Progress", value: `${pct}% of ${number(run.planned)} planned · ${number(run.inScope)} in scope` },
      ...[["Answered", "answered"], ["Unknown", "unknown"], ["Without evidence", "noEvidence"], ["Inferred by Jev", "inferred"], ["Errors", "errors"], ["Skipped", "skipped"], ["Pages read", "pagesRead"], ["Model calls", "llmCalls"]].map(([name, key]) => ({ label: name, value: text(number(run[key])) })),
      ...(number(credits.spent) > 0 ? [{ label: "Credits", value: `${number(credits.spent)}${credits.cap === null ? "" : ` of ${number(credits.cap)}`} credits` }] : []),
      ...(run.stop ? [{ label: "Stopped", value: text(stop.message) || text(stop.reason) }] : []),
      ...(run.error ? [{ label: "Error", value: text(run.error) }] : []),
    ],
    verdict: run.probe ? `${verdicts[text(verdict.kind)] || text(verdict.kind)}: ${number(verdict.answered)} of ${number(verdict.settled)} settled records answered${top.value === undefined ? "" : `; ${percent(top.share)} of answers are ${label(top.value, field)}`}.` : "",
    bands: jev.read === undefined ? "" : `Jev read ${number(jev.read)} records. Confidence: ${number(bands.high)} at 0.80+, ${number(bands.mid)} at 0.60 to 0.80, ${number(bands.low)} below 0.60.`,
    picks: list(jev.picks).map((p) => ({ choice: label(p.choice, field), count: number(p.count), confident: number(p.confident) })),
    sample: list(run.sample).map((s) => ({
      label: text(s.label), status: text(s.status), reason: text(s.reason), value: label(s.value, field), quote: text(s.quote), source: text(s.sourceUrl),
      pick: label(record(s.jev).choice, field), confidence: s.jev ? percent(record(s.jev).confidence) : "", inferred: s.inferred ? "Inferred by Jev" : "",
    })),
    traces: traces.map((t) => ({
      id: text(t.id), label: text(t.label), status: text(t.status), value: label(t.value, field), quote: text(t.quote), source: text(t.sourceUrl),
      reason: text(t.reason), model: text(t.model), prompt: text(t.promptVersion), calls: number(t.calls), seconds: (number(t.ms) / 1000).toFixed(1),
      inference: t.inferred ? "Inferred by Jev" : "", pick: label(record(t.jev).choice, field), confidence: t.jev ? percent(record(t.jev).confidence) : "",
      steps: list(t.steps).map((s) => ({ text: stepText(s) })),
    })),
  };
}

export function answerRows(field: Row | undefined, answers: Row[]) {
  if (!field) return [];
  return answers.map((a) => {
    const evidence = text(a.evidence);
    const source = evidence.match(/^([\s\S]*?)\n\nSource: (\S+)(?: \((search result|inferred by Jev)\))?$/);
    return {
      record: text(a.account) || text(a.entityId), value: label(a.value, field), status: text(a.status),
      check: a.verification === null ? "" : `${a.verifiedBy === "read" ? "Jev read" : "Jev check"} ${number(a.verification).toFixed(2)}`,
      quote: source ? source[1] : evidence, source: source && /^https?:\/\//.test(source[2]) ? source[2] : "",
      via: source?.[3] === "search result" ? "Search result" : source?.[3] === "inferred by Jev" ? "Inferred by Jev" : "", observed: date(a.observedAt),
    };
  });
}

export const calls: CallFunctions = {
  field(_ctx, reads) { return { value: fieldPage(rows(reads.field)[0]) }; },
  run(_ctx, reads) { return { value: runPage(rows(reads.field)[0], rows(reads.run)[0], rows(reads.traces)) }; },
  answers(_ctx, reads) { return { value: answerRows(rows(reads.field)[0], rows(reads.answers)) }; },
};
