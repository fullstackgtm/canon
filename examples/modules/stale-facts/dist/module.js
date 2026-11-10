var module_default = {
  kind: "module",
  visibility: "open",
  id: "@examples/stale-facts",
  version: "0.3.0",
  title: "Stale facts",
  description: "For deals closing soon and the companies you see, a page at a time, shows the contested facts and the ones confirmed longest ago, and lets a member propose a correction with evidence for review.",
  author: { org: "canon" },
  engines: { moduleApi: "1" },
  nav: { label: "Stale facts", icon: "clipboard", section: "CRM", landing: "facts" },
  collections: {
    corrections: {
      label: "Correction",
      schema: { type: "object", value: {
        object: { fieldType: { type: "union", value: [{ type: "literal", value: "companies" }, { type: "literal", value: "deals" }], labels: { companies: "Company", deals: "Deal" } }, optional: false, label: "Record type" },
        record: { fieldType: { type: "string", maxLength: 200 }, optional: false, label: "Record id" },
        recordName: { fieldType: { type: "string", maxLength: 300 }, optional: true, label: "Record" },
        attribute: { fieldType: { type: "string", maxLength: 80 }, optional: false, label: "Field" },
        was: { fieldType: { type: "string", maxLength: 500 }, optional: true, label: "Value then" },
        value: { fieldType: { type: "string", maxLength: 500 }, optional: false, label: "Proposed value" },
        evidence: { fieldType: { type: "string", maxLength: 4e3 }, optional: false, label: "Evidence" },
        proposal: { fieldType: { type: "string" }, optional: true, label: "Proposal" },
        by: { fieldType: { type: "ref", to: "users" }, optional: false, label: "Proposed by" }
      } },
      key: "auto",
      owner: "by",
      indexes: {},
      access: { manager: "all", rep: "own" }
    }
  },
  views: {
    "corrections.all": { kind: "list", collection: "corrections", order: "desc", limit: 200 }
  },
  ops: {},
  reads: {
    deals: ["name", "companyId", "companyName"],
    companies: ["name"],
    proposals: ["status", "total", "pending", "applied", "skipped", "unchanged", "rejected", "decidedAt"]
  },
  facts: {
    companies: {
      read: ["industry", "employees", "annualRevenue", "country", "domain"],
      propose: ["industry", "employees", "annualRevenue", "country"]
    },
    deals: {
      read: ["stage", "amount", "closeDate", "nextStep"],
      propose: ["closeDate", "nextStep"]
    }
  },
  server: "dist/module.js",
  calls: {
    stale: {
      label: "Find stale facts",
      roles: ["admin", "manager", "rep"],
      agent: "allowed",
      args: { type: "object", value: {
        cursor: { fieldType: { type: "string", maxLength: 400 }, optional: true }
      } },
      reads: {
        deals: { canon: "deals.closedBetween", args: { from: { nowPlusDays: -30, as: "date" }, to: { nowPlusDays: 90, as: "date" } }, limit: 100 },
        companies: { canon: "companies.updatedSince", args: { since: 0, cursor: { arg: "cursor" } }, limit: 50 },
        dealFacts: { canon: "facts.forRecords", args: { object: "deals", ids: { read: "deals" } } },
        dealCompanyFacts: { canon: "facts.forRecords", args: { object: "companies", ids: { read: "deals", field: "companyId" } } },
        companyFacts: { canon: "facts.forRecords", args: { object: "companies", ids: { read: "companies" } } }
      },
      writes: [],
      returns: "value",
      result: { kind: "table", rows: "rows", empty: "{$result.message}", columns: [
        { label: "Record", value: "{$row.name}" },
        { label: "Type", value: "{$row.type}" },
        { label: "Field", value: "{$row.attribute}" },
        { label: "Value", value: "{$row.valueText}" },
        { label: "State", value: "{$row.stateText}" },
        { label: "Last confirmed", value: "{$row.confirmedAt|date}", empty: "Never" },
        { label: "Days since", value: "{$row.ageDays|number}", align: "end" }
      ], rowActions: [{
        call: "propose",
        label: "Propose a correction",
        args: { object: { row: "object" }, record: { row: "id" }, recordName: { row: "name" }, attribute: { row: "attribute" }, was: { row: "valueText" } },
        when: { field: "proposable", in: [true] }
      }] }
    },
    propose: {
      label: "Propose a correction",
      roles: ["admin", "manager", "rep"],
      agent: "human",
      reason: "A correction is a person's claim, made with their own evidence.",
      args: { type: "object", value: {
        object: { fieldType: { type: "union", value: [{ type: "literal", value: "companies" }, { type: "literal", value: "deals" }] }, optional: false },
        record: { fieldType: { type: "string", maxLength: 200 }, optional: false },
        recordName: { fieldType: { type: "string", maxLength: 300 }, optional: true },
        attribute: { fieldType: { type: "string", maxLength: 80 }, optional: false },
        was: { fieldType: { type: "string", maxLength: 500 }, optional: true },
        value: { fieldType: { type: "string", maxLength: 500 }, optional: false, label: "Correct value", help: "Money in whole units, dates as YYYY-MM-DD." },
        evidence: { fieldType: { type: "string", maxLength: 4e3 }, optional: false, label: "Evidence", widget: "textarea", help: "Where the correct value comes from: a quote, a link, a call note." }
      } },
      reads: {},
      writes: ["corrections"],
      returns: "value",
      result: { kind: "message" }
    },
    outcomes: {
      label: "Corrections and their outcomes",
      roles: ["admin", "manager", "rep"],
      agent: "allowed",
      reads: {
        corrections: { view: "corrections.all", limit: 200 },
        proposals: { canon: "proposals.byIds", args: { ids: { read: "corrections", field: "proposal" } } }
      },
      writes: [],
      returns: "value",
      result: { kind: "table", rows: "rows", empty: "No corrections proposed yet.", columns: [
        { label: "Record", value: "{$row.recordName}" },
        { label: "Field", value: "{$row.attribute}" },
        { label: "Was", value: "{$row.was}" },
        { label: "Proposed", value: "{$row.value}" },
        { label: "By", value: "{$row.by|user}" },
        { label: "Outcome", value: "{$row.outcome}" }
      ] }
    }
  },
  pages: [
    {
      path: "facts",
      title: "Stale facts",
      bind: {
        corrections: { view: "corrections.all" },
        stale: { call: "stale", args: { cursor: { query: "after", default: "" } } },
        outcomes: { call: "outcomes", refreshOn: ["corrections"] }
      },
      body: [
        { c: "header", title: "Stale facts", subtitle: "Deals closing from 30 days ago to 90 days out, and 50 of the companies you see, the ones changed longest ago first: contested facts first, then the ones confirmed longest ago." },
        { c: "callResult", from: "stale", label: "Facts to check" },
        { c: "actions", when: { bind: "stale", field: "next", set: true }, items: [{ navigate: "facts?after={$stale.next}", label: "Next 50 companies" }] },
        { c: "actions", when: { bind: "stale", field: "paged", in: [true] }, items: [{ navigate: "facts", label: "First 50 companies" }] },
        { c: "callResult", from: "outcomes", label: "Corrections you can see" }
      ]
    }
  ]
};

var grants = module_default.facts;
var PROPOSABLE = (object) => grants[object]?.propose ?? [];
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
      proposable: f.state !== "unknown" && PROPOSABLE(object).includes(f.attribute)
    }));
  }));
  return rows.sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || (a.confirmedAt ?? Infinity) - (b.confirmedAt ?? Infinity) || a.name.localeCompare(b.name));
}
function proposeIntents(ctx, a) {
  if (!PROPOSABLE(a.object).includes(a.attribute)) throw new Error(`Stale facts doesn't propose ${a.attribute}.`);
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
    const companies = reads.companies;
    const names = new Map([
      ...deals.map((d) => [d.id, d.name ?? d.id]),
      ...deals.flatMap((d) => d.companyId ? [[d.companyId, d.companyName ?? d.companyId]] : []),
      ...companies.map((c) => [c.id, c.name ?? c.id])
    ]);
    const rows = staleRows(ctx.now, names, [
      { object: "deals", rows: reads.dealFacts },
      { object: "companies", rows: reads.dealCompanyFacts },
      { object: "companies", rows: reads.companyFacts }
    ]);
    const message = "No deals close between 30 days ago and 90 days from now, and there are no companies you can see.";
    return { value: { rows, message, next: companies.at(-1)?.next ?? null, paged: Boolean(ctx.args.cursor) } };
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
