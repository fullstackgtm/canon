var PROPOSABLE = {
  companies: ["industry", "employees", "annualRevenue", "country"],
  deals: ["closeDate", "nextStep"],
  people: []
};
var MONEY = /* @__PURE__ */ new Set(["amount", "annualRevenue"]);
var NUMBER = /* @__PURE__ */ new Set(["employees"]);
var DAY = 864e5;
var STATE_ORDER = { contested: 0, resolved: 1, empty: 2, unknown: 3 };
var STATE_TEXT = { resolved: "Resolved", empty: "No value", unknown: "Not a field in this workspace" };
var valueText = (attribute, v) => v === null || v === void 0 ? "" : MONEY.has(attribute) && typeof v === "number" ? String(v / 100) : String(v);
function staleRows(now, names, groups) {
  const seen = /* @__PURE__ */ new Set();
  const row = (object, id) => ({ object, id, name: names.get(id) ?? id, type: object === "deals" ? "Deal" : "Company" });
  const rows = groups.flatMap(({ object, rows: rows2 }) => rows2.flatMap((r) => {
    if (seen.has(`${object}:${r.id}`)) return [];
    seen.add(`${object}:${r.id}`);
    return r.fields.map((f) => ({
      ...row(object, r.id),
      attribute: f.attribute,
      valueText: valueText(f.attribute, f.value),
      state: f.state,
      stateText: f.state === "contested" ? `Contested by ${f.contestedBy?.length ?? 0}` : STATE_TEXT[f.state],
      confirmedAt: f.confirmedAt ?? null,
      ageDays: f.confirmedAt === void 0 ? null : Math.floor((now - f.confirmedAt) / DAY),
      proposable: f.state !== "unknown" && PROPOSABLE[object].includes(f.attribute)
    }));
  }));
  return rows.sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || (a.confirmedAt ?? Infinity) - (b.confirmedAt ?? Infinity) || a.name.localeCompare(b.name));
}
function proposeIntents(ctx, a) {
  if (!PROPOSABLE[a.object].includes(a.attribute)) throw new Error(`Stale facts doesn't propose ${a.attribute}.`);
  const raw = a.value.trim();
  const number = Number(raw.replace(/[,\s]/g, ""));
  if ((MONEY.has(a.attribute) || NUMBER.has(a.attribute)) && !Number.isFinite(number)) throw new Error(`${a.attribute} is a number, and ${raw} isn't one.`);
  const value = MONEY.has(a.attribute) ? Math.round(number * 100) : NUMBER.has(a.attribute) ? number : raw;
  const key = `t${ctx.now}~${a.object}~${a.record}~${a.attribute}`.replace(/[^A-Za-z0-9_.:|@~-]/g, "_").slice(0, 200);
  const data = { object: a.object, record: a.record, recordName: a.recordName ?? a.record, attribute: a.attribute, ...a.was ? { was: a.was } : {}, value: raw, evidence: a.evidence, by: ctx.caller.userId };
  return [
    { op: "put", collection: "corrections", key, data, expect: [{ collection: "corrections", key, version: null }] },
    {
      op: "propose",
      operation: "facts.propose",
      reason: `Stale facts: ${data.recordName}'s ${a.attribute}`,
      stamp: { collection: "corrections", key, field: "proposal" },
      args: { object: a.object, facts: [{ id: a.record, attribute: a.attribute, value, evidence: a.evidence }] }
    }
  ];
}
var REJECTED = {
  unknown_record: "not a record you can see",
  unknown_attribute: "not a field in this workspace",
  field_locked: "your role can't edit that field",
  not_owned: "the workspace doesn't let modules change that field",
  invalid_value: "not a valid value for that field"
};
function outcomeText(p) {
  if (!p) return "Not proposed";
  if (p.rejected.length) return `Not stored: ${REJECTED[p.rejected[0].reason] ?? p.rejected[0].reason}`;
  if (p.unchanged) return "Already proposed with this value";
  if (p.pending) return "Waiting for review";
  if (p.applied) return "Accepted";
  if (p.skipped) return "Rejected by a reviewer";
  return p.status;
}
var calls = {
  stale(ctx, reads) {
    const deals = reads.deals;
    const names = new Map([
      ...deals.map((d) => [d.id, d.name ?? d.id]),
      ...deals.flatMap((d) => d.companyId ? [[d.companyId, d.companyName ?? d.companyId]] : []),
      ...reads.companies.map((c) => [c.id, c.name ?? c.id])
    ]);
    const rows = staleRows(ctx.now, names, [
      { object: "deals", rows: reads.dealFacts },
      { object: "companies", rows: reads.dealCompanyFacts },
      { object: "companies", rows: reads.watchedFacts }
    ]);
    const message = "No deals close between 30 days ago and 90 days from now, and you watch no companies.";
    return { value: { rows, message } };
  },
  propose(ctx) {
    return { intents: proposeIntents(ctx, ctx.args), value: "Sent for review. Its outcome shows under Corrections: a member who reviews facts accepts or rejects it." };
  },
  outcomes(_ctx, reads) {
    const byId = new Map(reads.proposals.map((p) => [p.id, p]));
    const rows = reads.corrections.map((d) => {
      const p = byId.get(String(d.data.proposal));
      const counts = p ? { status: p.status, pending: p.pending, applied: p.applied, skipped: p.skipped, unchanged: p.unchanged, rejected: p.rejected } : {};
      return { ...d.data, ...counts, outcome: outcomeText(p) };
    });
    return { value: { rows } };
  }
};
export {
  calls,
  outcomeText,
  proposeIntents,
  staleRows
};
