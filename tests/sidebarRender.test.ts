import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import * as nav from "../src/components/shell/nav.ts";
import { NAV_SLOTS } from "../modules/kernel/manifest.ts";

const require = createRequire(import.meta.url);
const childrenOnly = ({ children }: { children?: ReactNode }) => children;
const empty = () => null;
const source = readFileSync(new URL("../src/app/dashboard/dashboard-shell.tsx", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS },
});
const stubs: Record<string, unknown> = {
  "@/components/integration-gate": { IntegrationGate: childrenOnly },
  "@/lib/authMode": { LOCAL_AUTH: false },
  "@/components/local-auth-controls": { LocalInviteDialog: empty, LocalOrgSwitcher: empty, LocalUserButton: empty },
  "next/link": { default: ({ children, ...props }: { children?: ReactNode }) => createElement("a", props, children) },
  "next/navigation": { usePathname: () => "/dashboard/integrations" },
  "@clerk/nextjs": {},
  "@/lib/utils": { cn: require("clsx").clsx },
  "@/components/background-activity-tray": { BackgroundActivityDock: empty },
  "@/components/icps/signup-market-banner": { SignupMarketBanner: empty },
  "@/components/shell/access-preview-banner": { AccessPreviewBanner: empty },
  "@/components/logo": { Logo: empty, LogoMark: empty },
  "@/components/ui/button": { Button: childrenOnly },
  "@/components/ui/sheet": {
    // Render drawer contents even while closed, so SSR checks the mobile path too.
    Sheet: childrenOnly,
    SheetContent: ({ children }: { children?: ReactNode }) => createElement("section", { "data-mobile-drawer": true }, children),
    SheetTitle: childrenOnly,
  },
  "@/components/ui/tooltip": { Tooltip: childrenOnly, TooltipTrigger: childrenOnly, TooltipContent: childrenOnly },
  "@/components/shell/nav": nav,
  "@/components/shell/use-nav-sections": { useNavSections: () => nav.visibleSections([], [{ slug: "work", nav: null, links: [{ id: "my-work", ...NAV_SLOTS["my-work"] }, { id: "review", ...NAV_SLOTS.review }] }, { slug: "dialer", nav: { id: "dialer", label: "Dialer", icon: "phone", section: "Activity", href: "/dashboard/m/dialer/dialer", legacy: "/dashboard/dialer" } }]) },
  "@/components/records/record-inspection": { RecordInspection: childrenOnly },
  "@/components/customize/customize-mode": { CustomizeProvider: childrenOnly },
  "@/components/shell/command-palette": { CommandPalette: empty },
  "@/components/shell/agent-onboarding": { AgentOnboardingOverlay: empty, useAgentGate: () => ({ locked: false, domain: null }) },
  "@/components/shell/ask-canon": { AskCanon: empty, OPEN_ASK_EVENT: "fsgtm:open-ask" },
  "@/components/shell/onboarding-checklist": { OnboardingChecklist: empty },
  "@/components/shell/notifications-bell": { NotificationsBell: empty },
  "@/components/shell/org-switcher": { DevOrgSwitcher: empty, OrgSwitcher: empty },
  "@/components/shell/workspace-theme": { WorkspaceTheme: empty },
  "@/components/shell/dev-member-switcher": { DevUserButton: empty },
  "@/hooks/use-onboarding-steps": { useOnboardingSteps: () => [] },
  "@/components/tasks/due-count": { useDueTaskCount: () => 0 },
};
const exports: { DashboardShell?: (props: { children?: ReactNode }) => ReactNode } = {};
runInNewContext(outputText, {
  exports,
  process: { env: { NEXT_PUBLIC_FSGTM_UI_SMOKE_BYPASS: "true" } },
  require: (id: string) => {
    if (Object.hasOwn(stubs, id)) return stubs[id];
    assert.ok(["react", "react/jsx-runtime", "lucide-react"].includes(id), `Unexpected shell dependency: ${id}`);
    return require(id);
  },
});

for (const [surface, pattern] of [
  ["desktop sidebar", /<aside\b[^>]*>([\s\S]*?)<\/aside>/],
  ["mobile drawer", /<section data-mobile-drawer="true">([\s\S]*?)<\/section>/],
] as const) {
  test(`${surface} renders navigation with work and review destinations`, () => {
    assert.ok(exports.DashboardShell);
    const html = renderToStaticMarkup(createElement(exports.DashboardShell));
    const sidebar = html.match(pattern)?.[1];
    assert.ok(sidebar, `${surface} must render`);
    assert.match(sidebar, /<nav\b/);
    const navigation = sidebar.match(/<nav\b[^>]*>([\s\S]*?)<\/nav>/)?.[1];
    assert.ok(navigation);
    assert.deepEqual([...navigation.matchAll(/href="([^"]+)"/g)].map((match) => match[1]), [
      "/dashboard/accounts", "/dashboard/contacts", "/dashboard/icps", "/dashboard/audiences",
      "/dashboard/tasks", "/dashboard/facts",
      "/dashboard/deals", "/dashboard/dashboards", "/dashboard/linkedin", "/dashboard/m/dialer/dialer", "/dashboard/runs", "/dashboard/agents",
      "/dashboard/settings", "/dashboard/customization", "/dashboard/integrations", "/dashboard/fields", "/dashboard/cli-auth",
    ]);
    assert.match(sidebar, /href="\/dashboard\/contacts"/);
    assert.match(sidebar, />People<\/span>/);
    assert.match(sidebar, />My work<\/span>/);
    assert.match(sidebar, />Review<\/span>/);
    assert.match(sidebar, /aria-expanded="true"/);
    if (surface === "desktop sidebar") assert.match(sidebar, /aria-label="Search records and commands"/);
  });
}
