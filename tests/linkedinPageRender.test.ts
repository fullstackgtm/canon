import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

const require = createRequire(import.meta.url);
const empty = () => null;
const childrenOnly = ({ children }: { children?: ReactNode }) => children;

function pageHarness(statuses: string[]) {
  const account = {
    _id: "sender", status: "paused", statusReason: "Sending paused for safety",
    timezone: "UTC", profileName: "Sender", pendingInvites: 8,
    usage: { invitesToday: 2, invitesWeek: 10, messagesToday: 3 },
    today: { invitesPerDay: 15, invitesPerWeek: 80, messagesPerDay: 20 },
    acceptance: { accepted: 5, sent: 10 },
  };
  const states: unknown[] = [];
  let stateIndex = 0;
  let settingsProps: unknown;
  let settingsClick: (() => void) | undefined;
  let close: ((open: boolean) => void) | undefined;
  const stubs: Record<string, unknown> = {
    react: { ...require("react"), useState: (initial: unknown) => {
      const index = stateIndex++;
      if (!(index in states)) states[index] = initial;
      return [states[index], (value: unknown) => { states[index] = value; }];
    } },
    "react/jsx-runtime": require("react/jsx-runtime"),
    "next/link": { default: childrenOnly },
    "convex/react": { useQuery: (query: string) => query === "mine" ? { account, isAdmin: true } : statuses.map((status, i) => ({ _id: String(i), name: `Cadence ${i}`, status, steps: 2 })), useMutation: () => empty, useAction: () => empty },
    "../../../../convex/_generated/api": { api: { linkedin: { mine: "mine" }, linkedinCadences: { list: "list" } } },
    "../../../../convex/lib/linkedin/cadence": { rate: (a: number, b: number) => b ? a / b * 100 : null },
    "../../../../convex/lib/linkedin/activity": { ACTIVE_WITHIN_DAYS_CHOICES: [0, 30, 60, 90, 180] },
    "@/components/dashboard": {
      ViewFrame: ({ actions = [], children }: { actions?: { id: string; onClick?: () => void }[]; children?: ReactNode }) => {
        settingsClick = actions.find((a) => a.id === "linkedin-settings")?.onClick;
        return children;
      },
       LoadingRows: empty, EmptyState: empty },
    "@/components/ui/dialog": {
      Dialog: ({ open, onOpenChange, children }: { open: boolean; onOpenChange: (open: boolean) => void; children: ReactNode }) => {
        if (open) close = onOpenChange;
        return open ? children : null;
      },
      DialogContent: childrenOnly, DialogTitle: childrenOnly, DialogDescription: childrenOnly,
    },
    "@/lib/toast": {}, "@/lib/linkedin-people": {},
    "@/lib/utils": { cn: (...values: unknown[]) => values.filter(Boolean).join(" ") },
    // The canvas is visual; these tests read the list view it switches with.
    "@/components/flow/flow-canvas": { FlowSwitch: ({ list }: { list: ReactNode }) => list, FlowCanvas: () => null, FlowRows: () => null },
    "@/components/ui/select": { SelectField: ({ options, value, disabled, "aria-label": label }: { options: { value: string; label: ReactNode }[]; value: string; disabled?: boolean; "aria-label"?: string }) => createElement("button", { type: "button", role: "combobox", "aria-label": label, disabled }, options.find((o) => o.value === value)?.label) },
    "./segment-breakdown": { SegmentBreakdown: () => null },
    "./cadence-insights": { CadenceActivity: ({ cadences }: { cadences: unknown[] }) => createElement("section", { "aria-label": "Activity across cadences", "data-cadences": cadences.length }), pct: (n: number | null) => n === null ? "–" : `${n}%` },
    "../integrations/linkedin-card": { AccountSettings: (props: unknown) => { settingsProps = props; return createElement("form", { "aria-label": "Account settings" }); }, IntakeSettings: () => null },
  };
  const { outputText } = ts.transpileModule(readFileSync(new URL("../src/app/dashboard/linkedin/page.tsx", import.meta.url), "utf8"), {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS },
  });
  const exports: { default?: () => ReactNode } = {};
  runInNewContext(outputText, { exports, require: (id: string) => {
    if (Object.hasOwn(stubs, id)) return stubs[id];
    assert.equal(id, "lucide-react");
    return require(id);
  } });
  return {
    render: () => { stateIndex = 0; return renderToStaticMarkup(createElement(exports.default!)); },
    openSettings: () => { assert.ok(settingsClick); settingsClick(); },
    closeSettings: () => { assert.ok(close); close(false); },
    settingsProps: () => settingsProps,
    account,
  };
}

test("LinkedIn shows a tabular summary above cadences only with multiple running cadences", () => {
  for (const statuses of [[], ["active"], ["active", "paused"], ["paused", "paused"]]) {
    const html = pageHarness(statuses).render();
    assert.doesNotMatch(html, /aria-label="Summary"/);
    assert.match(html, /Sending paused for safety/);
  }
  const html = pageHarness(["active", "active", "paused"]).render();
  assert.ok(html.indexOf('aria-label="Summary"') < html.indexOf('aria-label="Cadences"'));
  assert.match(html, /aria-label="Activity across cadences" data-cadences="3"/);
  assert.ok(html.indexOf('aria-label="Activity across cadences"') < html.indexOf('aria-label="Cadences"'));
  assert.match(html, /aria-label="Summary"[\s\S]*?<table/);
  for (const value of ["2 / 15", "10 / 80", "3 / 20", "8", "50%"]) assert.ok(html.includes(`>${value}</td>`));
});

test("LinkedIn settings button opens the existing account form and the modal closes", () => {
  const page = pageHarness([]);
  assert.doesNotMatch(page.render(), /aria-label="Account settings"/);
  page.openSettings();
  assert.match(page.render(), /aria-label="Account settings"/);
  const props = page.settingsProps() as { account: unknown; isAdmin: boolean };
  assert.equal(props.account, page.account);
  assert.equal(props.isAdmin, true);
  page.closeSettings();
  assert.doesNotMatch(page.render(), /aria-label="Account settings"/);
});
