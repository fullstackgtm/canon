"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useMutation } from "convex/react";
import { CheckCircle2, ChevronDown, ChevronUp, Circle, Copy, Lock } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { CreditsMeter } from "@/components/shell/credits-meter";
import { api } from "../../../convex/_generated/api";

export type OnboardingStep = {
  id: string;
  label: string;
  /** A page to open, or */
  href?: string;
  /** a prompt to copy and paste into the user's agent. */
  prompt?: string;
  /** Optional steps get a Skip button. */
  skippable?: boolean;
  completable?: boolean;
  done: boolean;
};

const EXPANDED_KEY = "fsgtm-onboarding-expanded";

function readFlag(key: string, fallback: boolean): boolean {
  try {
    const v = window.localStorage.getItem(key);
    return v === null ? fallback : v === "true";
  } catch {
    return fallback;
  }
}

function writeFlag(key: string, value: boolean) {
  try {
    window.localStorage.setItem(key, String(value));
  } catch {
    // storage unavailable (private mode); state stays in memory
  }
}

/**
 * Sequential setup checklist: a step unlocks only once every earlier step is
 * done. Agent-driven steps copy a prompt for the user's agent. Data comes entirely from `steps`; the shell feeds it from
 * `useOnboardingSteps()`. Once every step is done, the same slot shows the
 * workspace's credits.
 */
export function OnboardingChecklist({
  steps,
  collapsed = false,
}: {
  steps: OnboardingStep[];
  collapsed?: boolean;
}) {
  const [expanded, setExpanded] = useState(true);
  const completePlanTask = useMutation(api.onboarding.completePlanTask);
  const skipStep = useMutation(api.onboarding.skipStep);

  useEffect(() => {
    // Read persisted UI prefs after mount to avoid hydration mismatches.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setExpanded(readFlag(EXPANDED_KEY, true));
  }, []);

  const total = steps.length;
  const completed = steps.filter((s) => s.done).length;
  if (total === 0) return null;
  if (completed === total) return <CreditsMeter collapsed={collapsed} />;

  const pct = (completed / total) * 100;
  const firstOpen = steps.findIndex((s) => !s.done);

  if (collapsed) {
    return (
      <div
        className="flex justify-center border-t border-sidebar-border py-2 font-mono text-[10px] text-sidebar-foreground/60"
        title={`Setup ${completed}/${total}`}
      >
        {completed}/{total}
      </div>
    );
  }

  return (
    <div className="border-t border-sidebar-border px-2 py-2">
      <button
        type="button"
        onClick={() =>
          setExpanded((e) => {
            writeFlag(EXPANDED_KEY, !e);
            return !e;
          })
        }
        className="flex w-full items-center gap-2 px-2 py-1 text-xs font-medium text-sidebar-foreground/50 hover:text-sidebar-foreground/70"
      >
        {expanded ? <ChevronDown className="size-3" /> : <ChevronUp className="size-3" />}
        <span>Setup</span>
        <span className="ml-auto text-sidebar-foreground/70">
          {completed}/{total}
        </span>
      </button>
      <div className="mx-2 mt-1 h-[3px] bg-sidebar-border">
        <div className="h-[3px] bg-sidebar-primary transition-all" style={{ width: `${pct}%` }} />
      </div>

      {expanded && (
        <div className="mt-2 flex flex-col gap-0.5">
          {steps.map((step, i) => {
              const locked = !step.done && i > firstOpen;
              return (
                <div key={step.id} className="flex items-center gap-2 px-2 py-1">
                  {step.done ? (
                    <CheckCircle2 className="size-3.5 shrink-0 text-sidebar-primary" />
                  ) : locked ? (
                    <Lock className="size-3.5 shrink-0 text-sidebar-foreground/25" />
                  ) : (
                    <Circle className="size-3.5 shrink-0 text-sidebar-primary" />
                  )}
                  {step.completable && !step.done && !locked && <button type="button" aria-label={`Complete ${step.label}`} onClick={() => void completePlanTask({ stepId: step.id }).catch(() => toast.error("Could not save the task. Try again."))} className="text-sidebar-primary"><CheckCircle2 className="size-3.5" /></button>}
                  {locked ? (
                    <span className="text-xs text-sidebar-foreground/35">{step.label}</span>
                  ) : step.prompt && !step.done ? (
                    <button
                      type="button"
                      title="Copy the prompt for your agent"
                      onClick={() =>
                        void navigator.clipboard
                          ?.writeText(step.prompt ?? "")
                          .then(() => toast.success("Prompt copied. Paste it into your agent."))
                      }
                      className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-xs text-sidebar-foreground hover:text-sidebar-primary"
                    >
                      <span className="truncate">{step.label}</span>
                      <Copy className="size-3 shrink-0 text-sidebar-foreground/50" />
                    </button>
                  ) : !step.href ? (
                    <span
                      className={cn(
                        "text-xs",
                        step.done ? "text-sidebar-foreground/45 line-through" : "text-sidebar-foreground",
                      )}
                    >
                      {step.label}
                    </span>
                  ) : (
                    <Link
                      href={step.href}
                      className={cn(
                        "text-xs",
                        step.done
                          ? "text-sidebar-foreground/45 line-through"
                          : "text-sidebar-foreground hover:text-sidebar-primary",
                      )}
                    >
                      {step.label}
                    </Link>
                  )}
                  {step.skippable && !step.done && !locked && (
                    <button
                      type="button"
                      onClick={() =>
                        void skipStep({ stepId: step.id }).catch(() => toast.error("Couldn't skip this step. Try again."))
                      }
                      className="ml-auto shrink-0 text-[11px] text-sidebar-foreground/50 hover:text-sidebar-foreground"
                    >
                      Skip
                    </button>
                  )}
                </div>
              );
            })}
        </div>
      )}
    </div>
  );
}
