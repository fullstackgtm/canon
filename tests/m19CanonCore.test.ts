/** M19 Canon core: Settings > Team deep links and the deal import's Notes column. */
import assert from "node:assert/strict";
import test from "node:test";
import { linkedColumnFilters, managerMatches } from "../src/app/dashboard/settings/team-links.ts";
import { autoMap, importColumns } from "../convex/lib/objects/csvImport.ts";
import { resolveObjectDef, STANDARD_OBJECTS } from "../convex/lib/objects/registry.ts";

const plans = { id: "commissions:0", label: "Plans", values: { u1: ["AE Monthly"], u2: ["SDR Plan"] }, keys: { "AE Monthly": "mvcxoqna4dxhfe" } };

test("a Team link names a module column by its label, singular or plural, its value by text in any case or by key", () => {
  const filters = (qs: string) => linkedColumnFilters(new URLSearchParams(qs), [plans]);
  assert.deepEqual(
    [filters("plan=ae%20monthly"), filters("plans=mvcxoqna4dxhfe"), filters("col=Plans&value=SDR%20Plan"), filters("plan=nope"), filters("title=AE")],
    [{ "commissions:0": "AE Monthly" }, { "commissions:0": "AE Monthly" }, { "commissions:0": "SDR Plan" }, { "commissions:0": "nope" }, {}],
  );
});

test("?manager= matches a manager's id or name, or none", () => {
  const rep = { managerId: "m1", managerName: "Jordan Patel" };
  assert.deepEqual([managerMatches("m1", rep), managerMatches("jordan patel", rep), managerMatches("none", rep), managerMatches("Avery", rep)], [true, true, false, false]);
});

test("a deal import maps a Notes column to the description and offers no CRM id", () => {
  const def = resolveObjectDef(STANDARD_OBJECTS.deal, undefined);
  const cols = importColumns("deal", def).map((c) => c.apiName);
  assert.deepEqual([autoMap("deal", def, ["Deal name", "Notes"]), cols.some((c) => /crm|external/i.test(c))], [["name", "description"], false]);
});
