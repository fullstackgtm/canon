import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { createElement, type ComponentType, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { anyApi, getFunctionName } from "convex/server";
import ts from "typescript";

const require = createRequire(import.meta.url);
const childrenOnly = ({ children }: { children?: ReactNode }) => children;

function render(available: boolean, mailboxGrants = false, role = "admin", emailPolicy = false) {
  const settings = { modules: [{ moduleId: "visits", title: "Visit log", channels: [{ channel: "slack", on: true, names: ["visits"] }] }], local: true, slack: [], webhooks: [], rows: [] };
  const stubs: Record<string, unknown> = {
    "convex/react": {
      useQuery: (ref: Parameters<typeof getFunctionName>[0], args?: unknown) => {
        if (args === "skip") return undefined;
        const name = getFunctionName(ref);
        if (name === "organizations:context") return { organization: { currentUserRole: role, fiscalYearStartMonth: 1, timezone: "UTC", defaultCurrency: "USD" }, ...(available ? { features: { outbound: true, ...(mailboxGrants ? { mailboxGrants: true } : {}), ...(emailPolicy ? { outboundEmailPolicy: true } : {}) } } : {}) };
        if (name === "users:me") return { _id: role, orgId: "org" };
        if (name === "notifications:list") return { unread: 0, items: [], preview: null };
        if (name === "modules:sendPreview") {
          assert.ok(available, `Older backend has no ${name}`);
          return [{ channel: "slack", to: "#visits", text: "Acme visit is done", approval: false }];
        }
        if (name.startsWith("mailboxGrants:")) {
          assert.ok(mailboxGrants, `Older backend has no ${name}`);
          assert.equal(name, "mailboxGrants:mine");
          return { owner: { id: "rep", name: "Rep" }, accounts: [{ id: "mine", address: "rep@example.com" }], modules: [], grants: [], signingReady: true, maxDays: 90, maxPerDay: 100, nextCursor: null };
        }
        if (name.startsWith("outboundEmailPolicy:")) {
          assert.ok(emailPolicy && role === "admin", `Unsupported backend query ${name}`);
          assert.equal(name, "outboundEmailPolicy:get");
          return { postalAddress: "123 Main Street", recipientWeeklyCap: 3, timezone: "UTC", updatedAt: null };
        }
        if (name.startsWith("outbound:")) {
          assert.ok(available, `Older backend has no ${name}`);
          if (name === "outbound:settings") return role === "admin" ? settings : null;
          if (name === "outbound:emailChoices") return [{ moduleId: "visits", title: "Visit log", mode: "digest" }];
          if (name === "outbound:outbox") return [];
          assert.fail(`Unexpected outbound query ${name}`);
        }
        return null;
      },
      useMutation: () => () => Promise.resolve(),
    },
    "next/link": { default: childrenOnly },
    "@/components/ui/dialog": { Dialog: ({ open, children }: { open: boolean; children?: ReactNode }) => open ? children : null,
      DialogContent: childrenOnly, DialogDescription: childrenOnly, DialogFooter: childrenOnly, DialogHeader: childrenOnly, DialogTitle: childrenOnly },
    "@/components/ui/popover": { Popover: childrenOnly, PopoverContent: childrenOnly, PopoverTrigger: childrenOnly },
    "@/lib/utils": { cn: require("clsx").clsx, getErrorMessage: String },
    "@/lib/toast": { toast: {} },
    "@/components/dashboard": { ViewFrame: childrenOnly, LoadingRows: () => "Loading" },
    "./catalog": {},
    "./suppressions-section": { SuppressionsSection: () => null },
    "./workspace-form": { fiscalYearLabel: () => "FY26", fiscalQuarterLabel: () => "Q4" },
    "@/components/reports/pacing-chart": {},
    "../../../../modules/kernel/pacing": {},
    "../../../../modules/kernel/outbound": { OUTBOX_STATES: [] },
  };
  function load(path: string): Record<string, ComponentType<any>> {
    const source = readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
    const { outputText } = ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS } });
    const exports = {};
    runInNewContext(outputText, { exports, require: (id: string) => {
      if (id.endsWith("convex/_generated/api")) return { api: anyApi };
      if (id === "./mailbox-grants-section") return load("src/app/dashboard/settings/mailbox-grants-section.tsx");
      if (id === "./outbound-email-policy-section") return load("src/app/dashboard/settings/outbound-email-policy-section.tsx");
      if (id === "@/hooks/use-outbound-available") return load("src/hooks/use-outbound-available.ts");
      if (id === "@/components/modules/module-outbox") return load("src/components/modules/module-outbox.tsx");
      if (Object.hasOwn(stubs, id)) return stubs[id];
      assert.ok(["react", "react/jsx-runtime", "lucide-react"].includes(id), `Unexpected render dependency ${id}`);
      return require(id);
    } });
    return exports;
  }
  const { useSettingsSummaries } = load("src/app/dashboard/settings/settings-ui.tsx");
  const Summary = () => createElement("p", null, (useSettingsSummaries as unknown as () => { outbound: { value?: string } })().outbound.value);
  const { NotificationsBell } = load("src/components/shell/notifications-bell.tsx");
  const { OutboundTab } = load("src/app/dashboard/settings/outbound-tab.tsx");
  const { ModuleOutbox, SendPreview } = load("src/components/modules/module-outbox.tsx");
  return {
    summary: renderToStaticMarkup(createElement(Summary)),
    bell: renderToStaticMarkup(createElement(NotificationsBell)),
    settings: renderToStaticMarkup(createElement(OutboundTab)),
    outbox: renderToStaticMarkup(createElement(ModuleOutbox, { module: "visits", empty: "No visit messages" })),
    preview: renderToStaticMarkup(createElement(SendPreview, { module: "visits", machine: "visit", transition: "complete", docKey: "acme", args: {} })),
  };
}

test("existing views survive an older backend and expose outbound after it advertises support", () => {
  const before = render(false);
  assert.match(before.bell, /aria-label="Notifications"/);
  assert.match(before.bell, /Nothing yet/);
  assert.doesNotMatch(before.bell, /Email me/);
  assert.doesNotMatch(before.settings, /Slack webhook URL/);
  assert.equal(before.preview, "");
  const after = render(true);
  assert.equal(after.summary, "<p>1 channel on · local sink</p>");
  assert.match(after.bell, /Email Visit log notices/);
  assert.match(after.settings, /aria-label="Slack webhook URL"/);
  assert.match(after.settings, /aria-label="Visit log Slack"/);
  assert.equal(after.outbox, '<p class="text-sm text-muted-foreground">No visit messages</p>');
  assert.match(after.preview, /aria-label="What this sends"/);
  assert.match(after.preview, /Acme visit is done/);
});

test("reps see only their mailbox consent when the backend advertises grants", () => {
  const before = render(true, false, "rep");
  assert.doesNotMatch(before.settings, /aria-label="My mailbox grants"/);
  const owner = render(true, true, "rep");
  assert.match(owner.settings, /aria-label="My mailbox grants"/);
  assert.doesNotMatch(owner.settings, /aria-label="Slack webhook URL"/);
  assert.doesNotMatch(owner.settings, /aria-label="Endpoint URL"/);
});

test("the shared email policy form waits for backend support and stays hidden from reps", () => {
  assert.doesNotMatch(render(true).settings, /aria-label="Automated email policy"/);
  const admin = render(true, true, "admin", true);
  assert.match(admin.settings, /aria-label="Automated email policy"/);
  assert.match(admin.settings, /123 Main Street/);
  const rep = render(true, true, "rep", true);
  assert.match(rep.settings, /aria-label="My mailbox grants"/);
  assert.doesNotMatch(rep.settings, /aria-label="Automated email policy"/);
  assert.doesNotMatch(rep.settings, /aria-label="Slack webhook URL"/);
});
