"use client";

import { useQuery } from "convex/react";
import type { OnboardingStep } from "@/components/shell/onboarding-checklist";
import { useOrigin } from "@/components/shell/agent-onboarding";
import { starterPrompt, stepPrompt } from "@/lib/agentOnboarding";
import { api } from "../../convex/_generated/api";

// Agent-driven steps carry a prompt to paste into the agent instead of a page.
const STEP_META: Record<string, { label: string; href?: string; skippable?: boolean }> = {
  connect_agent: { label: "Connect your agent" },
  review_icp: { label: "Confirm your ICP" },
  research_accounts: { label: "Research accounts + contacts" },
  connect_crm: { label: "Connect your CRM", href: "/dashboard/integrations", skippable: true },
  invite_team: { label: "Invite your team", href: "/dashboard/settings/team", skippable: true },
};

/** Onboarding checklist state, backed by `api.onboarding.getSteps`. */
export function useOnboardingSteps(): OnboardingStep[] {
  const steps = useQuery(api.onboarding.getSteps, {});
  const plan = useQuery(api.onboarding.getStartingPlan, {});
  const agent = useQuery(api.agentConnections.mine, {});
  const domain = agent?.domain ?? null;
  const origin = useOrigin();
  // Nothing while loading, so a finished workspace never flashes the checklist.
  if (!steps) return [];
  // Steps without metadata (triage_tam) are not shown.
  const defaults = steps
    .filter((step) => step.id in STEP_META)
    .map((step) => ({
      id: step.id,
      ...STEP_META[step.id],
      prompt: (step.id === "connect_agent" ? starterPrompt(origin, domain) : stepPrompt(step.id, domain)) ?? undefined,
      done: step.done,
    }));
  if (!plan) return defaults;
  const planned = plan.tasks.map((task) => ({ ...task, done: steps.some((s) => s.id === task.id && s.done), completable: true }));
  return [
    ...defaults.filter((s) => s.id === "connect_agent"),
    ...planned,
    ...defaults.filter((s) => s.id !== "connect_agent" && !planned.some((p) => p.id === s.id)),
  ];
}
