import assert from "node:assert/strict";
import test from "node:test";
import { exportFileName, listCsv } from "../src/lib/list-csv.ts";
import { resolveObjectDef, STANDARD_OBJECTS } from "../convex/lib/objects/registry.ts";

test("a deal list exports picklist labels, money in units with its currency, lookups by title and id, owners by name, ISO dates, quoted and formula-safe cells", () => {
  const deal = resolveObjectDef(STANDARD_OBJECTS.deal);
  const csv = listCsv({
    fields: deal.fields,
    titleLabel: "Deal name",
    columns: ["stage", "amount", "companyId", "crmOwnerId", "nextStep", "updatedAt"],
    rows: [
      { id: "d1", title: "Acme, renewal", createdAt: 0, updatedAt: Date.UTC(2026, 9, 9, 12), values: { stage: "closed_won", amount: 125050, currency: "EUR", companyId: "acc_1", crmOwnerId: "u1", nextStep: "=HYPERLINK(\"x\")" } },
      { id: "d2", title: "Line\nbreak", createdAt: 0, updatedAt: Date.UTC(2026, 0, 2), values: { stage: "prospecting", amount: null, companyId: null, crmOwnerId: null, nextStep: "-2+3+cmd|calc" } },
    ],
    users: new Map([["u1", "Ada Lovelace"]]),
    titles: { acc_1: "Acme Corp" },
  });
  assert.equal(csv, [
    "ID,Deal name,Stage,Amount,Amount currency,Account,Account ID,CRM owner,Next step,Last modified",
    "d1,\"Acme, renewal\",Closed won,1250.50,EUR,Acme Corp,acc_1,Ada Lovelace,\"'=HYPERLINK(\"\"x\"\")\",2026-10-09T12:00:00.000Z",
    "d2,\"Line\nbreak\",Prospecting,,,,,,'-2+3+cmd|calc,2026-01-02T00:00:00.000Z",
    "",
  ].join("\n"));
  assert.equal(exportFileName("Deals", new Date(Date.UTC(2026, 9, 9))), "deals-2026-10-09.csv");
});

test("deal credit splits export their typed rows without losing member, percentage or kind", () => {
  const csv = listCsv({ fields: resolveObjectDef(STANDARD_OBJECTS.deal).fields, titleLabel: "Deal", columns: ["splitAllocations"],
    rows: [{ id: "d1", title: "Acme", createdAt: 0, updatedAt: 0, values: { splitAllocations: [{ userId: "u1", percentage: 100, kind: "revenue" }] } }],
    users: new Map(), titles: {},
  });
  assert.equal(csv, 'ID,Deal,Credit splits\nd1,Acme,"[{""userId"":""u1"",""percentage"":100,""kind"":""revenue""}]"\n');
});
