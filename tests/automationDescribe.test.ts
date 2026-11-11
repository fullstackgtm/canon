import assert from "node:assert/strict";
import test from "node:test";
import { FILTER_OPS } from "../modules/kernel/reportLanguage.ts";
import { actionValidator, describe, ownerChoiceValidator, triggerValidator, type AutomationAction, type OwnerChoice, type RuleNames, type Trigger } from "../modules/kernel/automation.ts";

const NAMES: RuleNames = {
  object: {
    label: "Deal",
    fields: [
      { apiName: "stage", label: "Stage", type: "picklist", options: [{ value: "proposal", label: "Proposal" }, { value: "won", label: "Closed won" }] },
      { apiName: "amount", label: "Amount", type: "currency" },
      { apiName: "closeDate", label: "Close date", type: "date" },
      { apiName: "companyId", label: "Account", type: "lookup" },
      { apiName: "custom.tier", label: "Tier", type: "text" },
    ],
  },
  related: { companyId: { label: "Account", fields: [{ apiName: "industry", label: "Industry", type: "text" }] } },
  members: [{ id: "users:avery", name: "Avery" }, { id: "users:morgan", name: "Morgan" }],
  teams: [{ id: "teamGroups:ent", name: "Enterprise" }],
  routingRules: [{ id: "routingRules:emea", name: "EMEA inbound" }],
  timezone: "America/New_York",
  currency: "USD",
};

const kinds = (union: { members: ReadonlyArray<{ fields: { kind: { value: string } } }> }) => union.members.map((m) => m.fields.kind.value).sort();

test("a rule reads as one sentence", () => {
  const rule = {
    object: "deal",
    trigger: { kind: "updated", field: "stage", to: ["proposal"] } as Trigger,
    conditions: [{ field: "amount", op: "gt", value: 5_000_000 }],
    actions: [
      { kind: "assign_owner", owner: { kind: "team", teamId: "teamGroups:ent" } },
      { kind: "create_task", subject: "Send the security review", dueInDays: 2, owner: { kind: "record_owner" } },
    ] as AutomationAction[],
  };
  assert.equal(describe(rule, NAMES),
    `When a deal's Stage changes to Proposal and Amount is over $50,000: assign it to the next member of the Enterprise team, then create a task "Send the security review" for the deal's owner, due in 2 days.`);
});

test("an If reads as a bracketed clause, a related record's field by its lookup, a nested If inside it", () => {
  const rule = {
    object: "deal",
    trigger: { kind: "created" } as Trigger,
    conditions: [],
    actions: [{
      kind: "if", conditions: [{ field: "companyId.industry", op: "eq", value: "SaaS" }],
      then: [{ kind: "if", conditions: [{ field: "amount", op: "gt", value: 5_000_000 }], then: [{ kind: "set_field", field: "stage", value: "proposal" }] }],
      else: [{ kind: "assign_owner", owner: { kind: "member", userId: "users:morgan" } }],
    }] as AutomationAction[],
  };
  assert.equal(describe(rule, NAMES), "When a deal is created: if Account's Industry is SaaS (if Amount is over $50,000 (set Stage to Proposal); otherwise assign it to Morgan).");
});

test("a custom field's own dotted name reads as the record's field, not a lookup", () => {
  const rule = { object: "deal", trigger: { kind: "created" } as Trigger, conditions: [], actions: [{ kind: "if", conditions: [{ field: "custom.tier", op: "eq", value: "Gold" }], then: [{ kind: "set_field", field: "custom.tier", value: "Platinum" }] }] as AutomationAction[] };
  assert.equal(describe(rule, NAMES), "When a deal is created: if Tier is Gold (set Tier to Platinum).");
});

test("every trigger, condition operator, owner choice and action the rule shape allows has words", () => {
  const triggers: Record<string, Trigger> = {
    created: { kind: "created" },
    updated: { kind: "updated", field: "stage", from: ["proposal"], to: ["won"] },
    deleted: { kind: "deleted" },
    schedule: { kind: "schedule", cadence: "weekly", weekday: 1, minute: 540 },
    manual: { kind: "manual" },
    webhook: { kind: "webhook", match: "custom.tier" },
  };
  const owners: Record<string, OwnerChoice> = {
    member: { kind: "member", userId: "users:avery" as never },
    record_owner: { kind: "record_owner" },
    company_owner: { kind: "company_owner" },
    round_robin: { kind: "round_robin", userIds: ["users:avery", "users:morgan"] as never },
    team: { kind: "team", teamId: "teamGroups:ent" as never },
    routing_rule: { kind: "routing_rule", routingRuleId: "routingRules:emea" as never },
  };
  const actions: Record<string, AutomationAction> = {
    set_field: { kind: "set_field", field: "stage", value: "won" },
    create_task: { kind: "create_task", subject: "Call", dueInDays: 1, owner: owners.member },
    assign_owner: { kind: "assign_owner", owner: owners.round_robin },
    wait: { kind: "wait", days: 2 },
    notify_slack: { kind: "notify_slack", channel: "sales", message: "{record} moved" },
    notify_email: { kind: "notify_email", to: { kind: "record_owner" }, subject: "Heads up", message: "{record}" },
    call_webhook: { kind: "call_webhook", endpointId: "recordWebhookEndpoints:1" as never },
    if: { kind: "if", conditions: [{ field: "companyId.industry", op: "eq", value: "SaaS" }], then: [{ kind: "set_field", field: "stage", value: "won" }] },
  };
  assert.deepEqual(Object.keys(triggers).sort(), kinds(triggerValidator), "a new trigger kind needs words in describe and a case here");
  assert.deepEqual(Object.keys(actions).sort(), kinds(actionValidator), "a new action kind needs words in describe and a case here");
  assert.deepEqual(Object.keys(owners).sort(), kinds(ownerChoiceValidator), "a new owner choice needs words in describe and a case here");

  const said = (s: string, raw: readonly string[]) => {
    assert.doesNotMatch(s, /undefined|\[object|NaN/, s);
    for (const r of raw) assert.ok(!s.includes(r), `${s} shows the raw ${r}`);
  };
  // A kind's own name can be an ordinary word in its sentence ("is created", "the Enterprise team"); a code name (set_field) never is.
  const code = (kind: string) => (kind.includes("_") ? [kind] : []);
  for (const trigger of Object.values(triggers)) said(describe({ object: "deal", trigger, conditions: [], actions: [actions.set_field] }, NAMES), []);
  for (const [kind, owner] of Object.entries(owners)) said(describe({ object: "deal", trigger: triggers.created, conditions: [], actions: [{ kind: "assign_owner", owner }] }, NAMES), [...code(kind), "users:", "teamGroups:", "routingRules:"]);
  for (const [kind, action] of Object.entries(actions)) said(describe({ object: "deal", trigger: triggers.created, conditions: [], actions: [action] }, NAMES), code(kind));
  for (const op of FILTER_OPS) {
    for (const field of ["amount", "closeDate"]) {
      // "contains", "in" and "empty" are words; "gte" or "hasAny" in a sentence would be the code showing through.
      const codeName = /[A-Z]/.test(op) || ["eq", "neq", "gt", "gte", "lt", "lte"].includes(op);
      said(describe({ object: "deal", trigger: triggers.created, conditions: [{ field, op, value: field === "amount" ? 10 : "{today}" }], actions: [actions.set_field] }, NAMES), codeName ? [` ${op} `] : []);
    }
  }
  assert.equal(describe({ object: "deal", trigger: triggers.schedule, conditions: [{ field: "closeDate", op: "lt", value: "{today}" }], actions: [{ kind: "set_field", field: "stage", value: null }] }, NAMES),
    "Every Monday at 09:00 (America/New_York), for each deal where Close date is before today: clear Stage.");
});
