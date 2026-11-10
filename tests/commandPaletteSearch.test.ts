import { test } from "node:test";
import assert from "node:assert/strict";
import { groupActivitySearchHits, groupSearchHits } from "../src/components/shell/record-search.ts";
import { moduleActivityOf } from "../modules/kernel/activities.ts";

test("the palette groups search hits by object, companies, people and deals first, keeping the server's order in each group", () => {
  const groups = groupSearchHits([
    { object: "task", id: "s-t", title: "Call Acme", updatedAt: 5 },
    { object: "deal", id: "s-d", title: "Acme renewal", updatedAt: 4, detail: { amount: 1200000, currency: "USD", stage: "proposal" } },
    { object: "contact", id: "con_2", title: "Ada Acme", updatedAt: 3, detail: { email: null, company: "Acme" } },
    { object: "account", id: "acc_1", title: "Acme", updatedAt: 2, detail: { domain: "acme.com" } },
    { object: "contact", id: "con_1", title: "Bo Lane", updatedAt: 1, detail: { email: "bo@acme.com", company: "Acme" } },
  ]);
  assert.deepEqual(groups, [
    { object: "account", label: "Accounts", records: [{ key: "account:acc_1", id: "acc_1", title: "Acme", detail: "acme.com", href: "/dashboard/accounts/acc_1" }] },
    {
      object: "contact", label: "People", records: [
        { key: "contact:con_2", id: "con_2", title: "Ada Acme", detail: "Acme", href: "/dashboard/records/contact/con_2" },
        { key: "contact:con_1", id: "con_1", title: "Bo Lane", detail: "bo@acme.com", href: "/dashboard/records/contact/con_1" },
      ],
    },
    { object: "deal", label: "Opportunities", records: [{ key: "deal:s-d", id: "s-d", title: "Acme renewal", detail: "$12,000.00 · Proposal", href: "/dashboard/records/deal/s-d" }] },
    { object: "task", label: "Tasks", records: [{ key: "task:s-t", id: "s-t", title: "Call Acme", detail: null, href: "/dashboard/records/task/s-t" }] },
  ]);
});

test("the palette keeps declared module activity links and identities in one Activities group", () => {
  const declaration = { kind: "visit", subject: "title", targets: {}, path: "visits/:key" };
  const doc = { key: "a/b?c", version: 1, owner: null, parentKey: null, data: { title: "Atlas visit" }, createdAt: 1, updatedAt: 2 };
  const hits = ["@test/first", "@test/second"].map((moduleId) => {
    const { activity } = moduleActivityOf(moduleId, "events", "visits", declaration, doc);
    return { id: activity.id, title: activity.subject, activityKind: activity.activityKind, moduleTitle: "Events", source: activity.source };
  });
  assert.deepEqual(groupActivitySearchHits(hits), [{ object: "module-activity", label: "Activities", records: [
    { key: "module:%40test%2Ffirst/visits/a%2Fb%3Fc", id: "module:%40test%2Ffirst/visits/a%2Fb%3Fc", title: "Atlas visit", detail: "Events · visit", href: "/dashboard/m/events/visits/a%2Fb%3Fc" },
    { key: "module:%40test%2Fsecond/visits/a%2Fb%3Fc", id: "module:%40test%2Fsecond/visits/a%2Fb%3Fc", title: "Atlas visit", detail: "Events · visit", href: "/dashboard/m/events/visits/a%2Fb%3Fc" },
  ] }]);
  assert.deepEqual(groupActivitySearchHits([]), []);
});
