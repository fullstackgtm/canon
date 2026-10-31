import assert from "node:assert/strict";
import { test } from "node:test";
import { placements, scopeOf } from "../recipes/actions.ts";
import { holds, parseCondition, type Context } from "../recipes/conditions.ts";

test("conditions are parsed against their action's scope, evaluated without running code, and refuse anything else", () => {
  const scope = scopeOf("kernel.sendEmail", "draftPanel");
  const ctx: Context = { canEdit: true, stage: "case", "step.channel": "email", "draft.subject": false, "picked.count": 3, "gmail.linked": true };
  const cases: Array<[string, boolean]> = [
    ["canEdit", true],
    ["!canEdit || stage == \"in\"", false],
    ['step.channel == "email" && gmail.linked', true],
    ["gmail.linked && !draft.subject", true],
    ["(canEdit || draft.subject) && stage != 'close'", true],
    ["person.email", false],
    ["canEdit && true && !false", true],
  ];
  for (const [text, want] of cases) {
    const parsed = parseCondition(text, scope);
    assert.ok(parsed.ok, `${text}: ${parsed.ok ? "" : parsed.error}`);
    assert.equal(holds(parsed.condition, ctx), want, text);
  }
  const counts = parseCondition("picked.count > 2 && picked.count <= 3", scopeOf("kernel.firstTouches", "fanOut"));
  assert.ok(counts.ok && holds(counts.condition, ctx));

  for (const text of [
    'constructor.constructor("return process")()', "__proto__", "canEdit; globalThis.alert(1)", "`${canEdit}`", "canEdit = true",
    'stage == "won"', "picked.count", 'canEdit == "yes"', "stage > 1", "(canEdit", "", "canEdit &&",
  ]) assert.equal(parseCondition(text, scopeOf("kernel.firstTouches", "fanOut")).ok, false, text);

  for (const p of placements()) {
    for (const text of [p.requires, p.ready, p.after]) if (text) assert.ok(parseCondition(text, scopeOf(p.id, p.host, p.object)).ok, `${p.id} in ${p.object}.${p.host}: ${text}`);
  }
});
