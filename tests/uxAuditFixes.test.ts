import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { matchPage, moduleSlug, pagesOf, parseModuleManifest } from "../modules/kernel/manifest.ts";
import { loadConvex, memoryDb } from "./convexHandlers.ts";

const require = createRequire(import.meta.url);
const childrenOnly = ({ children }: { children?: ReactNode }) => children;

function loadTsx<T extends Record<string, unknown>>(relPath: string, stubs: Record<string, unknown>): T {
  const source = readFileSync(new URL(`../${relPath}`, import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS },
  });
  const exports = {} as T;
  runInNewContext(outputText, {
    exports,
    process: { env: {} },
    require: (id: string) => (Object.hasOwn(stubs, id) ? stubs[id] : require(id)),
  });
  return exports;
}

const linkStub = {
  default: ({ children, ...props }: { children?: ReactNode }) => createElement("a", props, children),
};

test("Integrations -> Dialer links to /dashboard/m/dialer/dialer", () => {
  const mod = loadTsx<{ default: () => ReactNode }>("src/app/dashboard/integrations/dialer/page.tsx", {
    "next/link": linkStub,
    "@/components/salesforce-sync/ui": { Panel: childrenOnly },
    "../integration-ui": { IntegrationPage: childrenOnly },
    "../dialer-card": { DialerControls: () => null },
  });
  const html = renderToStaticMarkup(createElement(mod.default));
  const parsed = parseModuleManifest(JSON.parse(readFileSync("modules/examples/dialer/module.json", "utf8")));
  assert.ok(parsed.ok);
  const hit = matchPage(pagesOf(parsed.manifest), ["dialer"]);
  assert.ok(hit);
  assert.ok(html.includes(`href="/dashboard/m/${moduleSlug(parsed.manifest.id)}/${hit.page.path}"`));
  assert.doesNotMatch(html, /href="\/dashboard\/dialer"/);
});

test("connect_agent is skippable in onboarding and checklist does not lock later steps or hide CreditsMeter", async () => {
  const user = { _id: "u1", orgId: "org1", role: "admin" };
  const loaded = loadConvex(["onboarding.ts"], {
    "lib.ts": (r) => ({ ...r, getCurrentUser: async () => user }),
    "agentConnections.ts": (r) => ({ ...r, hasAgentConnection: async () => false }),
    "lib/icpsInterface.ts": (r) => ({ ...r, readIcps: async () => [] }),
  });
  const onboarding = loaded["onboarding.ts"];

  const db = memoryDb({
    organizations: [{ _id: "org1" }],
    users: [user],
    orgOnboardingSteps: [],
    researchRuns: [],
    integrations: [],
  });
  const ctx = { db };
  await onboarding.skipStep.handler(ctx, { stepId: "connect_agent" });
  const steps = await onboarding.getSteps.handler(ctx, {});
  assert.equal(steps.find((s: { id: string; done: boolean }) => s.id === "connect_agent")?.done, true);

  const queryResults = [steps.map((step: { id: string }) => ({ ...step, done: false })), null, null];
  const hook = loadTsx<{ useOnboardingSteps: () => Array<{ id: string; skippable?: boolean; href?: string; prompt?: string }> }>("src/hooks/use-onboarding-steps.ts", {
    "convex/react": { useQuery: () => queryResults.shift() },
    "@/components/shell/agent-onboarding": { useOrigin: () => "http://localhost" },
    "@/lib/agentOnboarding": { starterPrompt: () => "prompt", stepPrompt: () => null },
    "../../convex/_generated/api": { api: { onboarding: {}, agentConnections: {} } },
  });
  const defaults = hook.useOnboardingSteps();
  assert.equal(defaults.find((step) => step.id === "connect_agent")?.skippable, true);
  for (const id of ["review_icp", "research_accounts"]) {
    const step = defaults.find((step) => step.id === id);
    assert.ok(step?.href);
    assert.equal(step.prompt, undefined);
  }

  const checklistMod = loadTsx<{ OnboardingChecklist: (props: { steps: unknown[] }) => ReactNode }>(
    "src/components/shell/onboarding-checklist.tsx",
    {
      "next/link": linkStub,
      "convex/react": { useMutation: () => async () => {} },
      sonner: { toast: { success: () => {}, error: () => {} } },
      "@/lib/utils": { cn: require("clsx").clsx },
      "@/components/shell/credits-meter": {
        CreditsMeter: () => createElement("div", { "data-credits-meter": "true" }, "Credits"),
      },
      "../../../convex/_generated/api": {
        api: { onboarding: { completePlanTask: "completePlanTask", skipStep: "skipStep" } },
      },
    },
  );

  const openHtml = renderToStaticMarkup(
    createElement(checklistMod.OnboardingChecklist, {
      steps: [
        { id: "connect_agent", label: "Connect your agent", prompt: "prompt", skippable: true, done: false },
        { id: "triage_tam", label: "Choose your first accounts", href: "/dashboard/accounts", completable: true, done: false },
        { id: "connect_crm", label: "Connect your CRM", href: "/dashboard/integrations", skippable: true, done: false },
      ],
    }),
  );
  assert.match(openHtml, /href="\/dashboard\/accounts"/);
  assert.match(openHtml, /href="\/dashboard\/integrations"/);
  assert.match(openHtml, /aria-label="Complete Choose your first accounts"/);
  assert.equal((openHtml.match(/>Skip</g) ?? []).length, 2);

  const doneHtml = renderToStaticMarkup(
    createElement(checklistMod.OnboardingChecklist, {
      steps: [
        { id: "connect_agent", label: "Connect your agent", skippable: true, done: true },
        { id: "connect_crm", label: "Connect your CRM", skippable: true, done: true },
      ],
    }),
  );
  assert.match(doneHtml, /data-credits-meter="true"/);
});

