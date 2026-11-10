import { test } from "node:test";
import assert from "node:assert/strict";
import {
  NAV_SECTIONS,
  PALETTE_SECTIONS,
  getActiveSectionLabel,
  homeHref,
  isNavItemActive,
  visibleSections,
  withModules,
  movedTo,
  withoutHidden,
  type NavModule,
} from "../src/components/shell/nav.ts";
import { NAV_SLOTS } from "../modules/kernel/manifest.ts";
import { NAV_PAGES } from "../recipes/models.ts";
import { parseUrlState, serializeUrlState } from "../src/lib/url-state-core.ts";

import { reportsModuleTarget } from "../src/components/shell/nav.ts";

const WORK: NavModule = { slug: "work", nav: null, links: [{ id: "my-work", ...NAV_SLOTS["my-work"] }, { id: "review", ...NAV_SLOTS.review }] };
const DIALER: NavModule = { slug: "dialer", nav: { id: "dialer", label: "Dialer", icon: "phone", section: "Activity", href: "/dashboard/m/dialer/dialer", legacy: "/dashboard/dialer" } };
const REPORTS: NavModule = { moduleId: "@canon/reports", reportsTakeover: true, slug: "reports", nav: { id: "reports", label: "Reports", icon: "chart", section: "Activity", href: "/dashboard/m/reports/pacing", legacy: "/dashboard/dashboards" } };
const SIDEBAR = visibleSections([], [WORK, REPORTS, DIALER]);

const SIDEBAR_HREFS = [
  "/dashboard/accounts", "/dashboard/contacts", "/dashboard/icps", "/dashboard/audiences",
  "/dashboard/tasks", "/dashboard/facts",
  "/dashboard/deals", "/dashboard/m/reports/pacing", "/dashboard/linkedin", "/dashboard/m/dialer/dialer", "/dashboard/runs", "/dashboard/agents",
  "/dashboard/settings", "/dashboard/customization", "/dashboard/automations", "/dashboard/integrations", "/dashboard/canon-fields", "/dashboard/account-hierarchy", "/dashboard/fields", "/dashboard/cli-auth",
];

test("the sidebar groups and orders CRM, Work, Activity and Admin destinations, Work from its module", () => {
  const hrefs = SIDEBAR.flatMap((s) => s.items.map((i) => i.href));
  assert.deepEqual(hrefs, SIDEBAR_HREFS);
  assert.ok(NAV_SECTIONS.every((s) => s.label !== "Work"), "Canon's own pages hold no Work section");
  assert.equal(SIDEBAR.find((s) => s.label === "Work")?.items[0].badge, "dueTasks");
  assert.deepEqual(SIDEBAR.map((s) => [s.label, s.items.map((i) => i.label)]), [
    ["CRM", ["Accounts", "People", "ICPs", "Audiences"]],
    ["Work", ["My work", "Review"]],
    ["Activity", ["Opportunities", "Reports", "LinkedIn", "Dialer", "Runs", "Agents"]],
    ["Admin", ["Settings", "Customization", "Automations", "Integrations", "Canon fields", "Account hierarchy", "AI fields", "CLI Pairing"]],
  ]);
  assert.equal(NAV_SECTIONS[0].items.find((i) => i.href === "/dashboard/contacts")?.label, "People");
  const visits: NavModule = { slug: "visit-log", nav: { label: "Visit log", icon: "map", section: "Work", href: "/dashboard/m/visit-log/visits" } };
  assert.deepEqual(visibleSections([], [visits, WORK]).find((s) => s.label === "Work")?.items.map((i) => i.label), ["My work", "Review", "Visit log"], "linked Canon pages lead their section");
});

test("workspace.nav hides pages by id, drops an emptied section, keeps Settings, Customization, Automations, Canon fields and Account hierarchy, and lands on a visible page", () => {
  assert.deepEqual(SIDEBAR.flatMap((s) => s.items.flatMap((i) => (i.id ? [i.id] : []))), [...NAV_PAGES]);
  const all = [...NAV_PAGES];
  const left = withoutHidden(SIDEBAR, all);
  assert.deepEqual(left.map((s) => [s.label, s.items.map((i) => i.label)]), [["Admin", ["Settings", "Customization", "Automations", "Canon fields", "Account hierarchy"]]]);
  const some = withoutHidden(withModules(NAV_SECTIONS, [REPORTS]), ["deals", "accounts"]);
  assert.equal(homeHref(some, "reports"), "/dashboard/m/reports/pacing");
  assert.equal(homeHref(some, "deals"), "/dashboard/contacts", "a hidden landing page falls back to the first visible page");
  assert.equal(homeHref(left, "deals"), "/dashboard/accounts");
  const visits = { slug: "visit-log", nav: { label: "Visits", icon: "map" as const, section: "Work", href: "/dashboard/m/visit-log/visits" } };
  assert.deepEqual(visibleSections(all, [visits, WORK]).map((s) => s.label), ["Work", "Admin"], "a module keeps its section when workspace.nav hides the rest of it");
});

test("a module's entry takes its page's place and id in the nav, and the page's old URLs open the module", () => {
  const withoutLinkedIn = NAV_SECTIONS.map((s) => ({ ...s, items: s.items.filter((i) => i.id !== "linkedin") }));
  const linkedin: NavModule = { slug: "linkedin", nav: { label: "LinkedIn", icon: "linkedin", section: "Activity", href: "/dashboard/m/linkedin/inbox", id: "linkedin", legacy: "/dashboard/linkedin" } };
  const activity = (sections: ReturnType<typeof withModules>) => sections.find((s) => s.label === "Activity")!.items.map((i) => [i.label, i.id ?? null]);
  assert.deepEqual(activity(withModules(withoutLinkedIn, [linkedin])), [
    ["Opportunities", "deals"], ["Reports", "reports"], ["LinkedIn", "linkedin"], ["Runs", "runs"], ["Agents", "agents"],
  ]);
  assert.deepEqual(activity(withModules(NAV_SECTIONS, [linkedin])), activity(NAV_SECTIONS), "a place Canon's page still holds stays Canon's, with no second entry");
  assert.equal(withoutHidden(withModules(withoutLinkedIn, [linkedin]), ["linkedin"]).flatMap((s) => s.items).some((i) => i.label === "LinkedIn"), false);
  assert.equal(movedTo("/dashboard/linkedin", [linkedin]), "/dashboard/m/linkedin/inbox");
  assert.equal(movedTo("/dashboard/linkedin/threads/7", [linkedin]), "/dashboard/m/linkedin/inbox");
  assert.equal(movedTo("/dashboard/linkedinx", [linkedin]), null);
  assert.equal(movedTo("/dashboard/tasks", [WORK]), null, "a page a module only links stays Canon's");
});

test("the palette lists the sidebar's pages and none of the retired ones", () => {
  assert.equal(PALETTE_SECTIONS, NAV_SECTIONS);
  const hrefs = SIDEBAR.flatMap((s) => s.items.map((i) => i.href));
  assert.deepEqual(hrefs, SIDEBAR_HREFS);
  for (const retired of ["/dashboard/records/product", "/dashboard/patch-plans", "/dashboard/reports", "/dashboard/duplicates"]) {
    assert.ok(!hrefs.includes(retired), `${retired} is off the nav`);
  }
});

test("palette hrefs and labels are unique", () => {
  const items = SIDEBAR.flatMap((s) => s.items);
  assert.equal(new Set(items.map((i) => i.href)).size, items.length);
  assert.equal(new Set(PALETTE_SECTIONS.map((s) => s.label)).size, PALETTE_SECTIONS.length);
});

test("active matching does not treat /dashboard as a prefix", () => {
  assert.equal(isNavItemActive("/dashboard/deals", "/dashboard"), false);
  assert.equal(isNavItemActive("/dashboard", "/dashboard"), true);
  assert.equal(isNavItemActive("/dashboard/accounts/abc", "/dashboard/accounts"), true);
  assert.equal(isNavItemActive("/dashboard/accountsx", "/dashboard/accounts"), false);
  assert.equal(getActiveSectionLabel("/dashboard/runs"), "Activity");
  assert.equal(getActiveSectionLabel("/dashboard/contacts/person-1"), "CRM");
  assert.equal(getActiveSectionLabel("/dashboard/deals/deal-1"), "Activity");
  assert.equal(getActiveSectionLabel("/dashboard/linkedin"), "Activity");
  assert.equal(getActiveSectionLabel("/dashboard/fields"), "Admin");
  assert.equal(getActiveSectionLabel("/dashboard/records/task/task-1", SIDEBAR), "Work");
  assert.equal(getActiveSectionLabel("/dashboard/records/note/note-1"), undefined);
  assert.equal(getActiveSectionLabel("/dashboard/integrations"), "Admin");
  assert.equal(getActiveSectionLabel("/dashboard/cli-auth"), "Admin");
  assert.equal(getActiveSectionLabel("/dashboard/records/product/product-1"), undefined);
});

test("record pages keep their primary CRM destination active", () => {
  for (const [object, href, section] of [
    ["account", "/dashboard/accounts", "CRM"],
    ["contact", "/dashboard/contacts", "CRM"],
    ["deal", "/dashboard/deals", "Activity"],
    ["task", "/dashboard/tasks", "Work"],
  ]) {
    const path = `/dashboard/records/${object}/record-1`;
    assert.equal(isNavItemActive(path, href), true);
    assert.equal(getActiveSectionLabel(path, SIDEBAR), section);
    assert.equal(isNavItemActive(path, "/dashboard/settings"), false);
  }
  assert.equal(isNavItemActive("/dashboard/records/invoice/record-1", "/dashboard/records/invoice"), true);
  assert.equal(isNavItemActive("/dashboard/records/contactx/record-1", "/dashboard/contacts"), false);
});

test("parseUrlState falls back to defaults", () => {
  const params = new URLSearchParams("q=acme&other=1");
  assert.deepEqual(parseUrlState(params, { q: "", sort: "name" }), { q: "acme", sort: "name" });
  assert.deepEqual(parseUrlState(new URLSearchParams(""), { tab: undefined }), { tab: undefined });
});

test("serializeUrlState drops defaults/empties and keeps unrelated params", () => {
  const defaults = { q: "", sort: "name" };
  assert.equal(serializeUrlState("other=1", defaults, { q: "acme" }), "other=1&q=acme");
  assert.equal(serializeUrlState("q=acme&sort=created", defaults, { sort: "name" }), "q=acme");
  assert.equal(serializeUrlState("q=acme", defaults, { q: "" }), "");
  assert.equal(serializeUrlState("q=a", defaults, { q: undefined }), "");
});

test("parse(serialize(x)) round-trips", () => {
  const defaults = { q: "", sort: "name", page: "1" };
  const qs = serializeUrlState("", defaults, { q: "a b&c", page: "3" });
  assert.deepEqual(parseUrlState(new URLSearchParams(qs), defaults), { q: "a b&c", sort: "name", page: "3" });
});


test("Reports takes its slot once, carries legacy queries, and leaves Canon pages when off", () => {
  const reports = { ...REPORTS, moduleId: "@canon/reports" };
  for (const pending of [[], [{ ...reports, reportsTakeover: false }], [{ ...reports, reportsTakeover: undefined }]]) {
    const entries = visibleSections([], pending).flatMap((s) => s.items).filter((i) => i.id === "reports");
    assert.deepEqual(entries.map((i) => i.href), ["/dashboard/dashboards"]);
    assert.equal(reportsModuleTarget(pending, "dashboards", "d=board"), null);
    assert.equal(movedTo("/dashboard/dashboards", pending), null);
  }
  const sections = visibleSections([], [reports]);
  assert.equal(sections.flatMap((s) => s.items).filter((i) => i.id === "reports").length, 1);
  assert.equal(homeHref(sections, "reports"), "/dashboard/m/reports/pacing");
  assert.equal(visibleSections(["reports"], [reports]).flatMap((s) => s.items).some((i) => i.id === "reports"), false);
  for (const [path, query, target] of [
    ["reports", "report=saved&x=keep", "/dashboard/m/reports/builder?report=saved&x=keep"],
    ["dashboards", "d=board", "/dashboard/m/reports/dashboards?d=board"],
    ["reports", "view=stages", "/dashboard/m/reports/stages?view=stages"],
    ["reports", "view=targets", "/dashboard/settings/targets?view=targets"],
    ["reports", "", "/dashboard/m/reports/builder"],
    ["dashboards", "", "/dashboard/m/reports/pacing"],
  ] as const) assert.equal(reportsModuleTarget([reports], path, query), target);
  assert.equal(reportsModuleTarget([], "reports", "report=saved"), null);
  assert.equal(reportsModuleTarget([{ ...reports, nav: null }], "dashboards", "d=board"), null);
});
