import { cn } from "@/lib/utils";

/**
 * Switchyard status tones: every status collapses to one of four semantic
 * tones — mint (good/live), amber (pending/attention), red (error/rejected),
 * dim (neutral) — so badges adapt to the dark instrument-panel theme instead
 * of carrying their own hardcoded palettes.
 */
type Tone = "good" | "pending" | "bad" | "neutral";

const TONE_STYLES: Record<Tone, string> = {
  good: "bg-primary/15 text-primary",
  pending: "bg-warning/15 text-warning",
  bad: "bg-destructive/15 text-destructive",
  neutral: "bg-muted text-muted-foreground",
};

const STATUS_TONES: Record<string, Tone> = {
  // Common
  active: "good",
  ok: "good",
  success: "good",
  healthy: "good",
  completed: "good",
  connected: "good",
  draft: "pending",
  pending: "pending",
  pending_approval: "pending",
  partial: "pending",
  warning: "pending",
  watch: "pending",
  at_risk: "pending",
  syncing: "pending",
  info: "neutral",
  inactive: "neutral",
  archived: "neutral",
  paused: "neutral",
  loading: "neutral",
  error: "bad",
  failed: "bad",
  conflict: "pending",
  disputed: "bad",
  cancelled: "bad",
  rejected: "bad",
  churning: "bad",
  churned: "bad",
  risk: "bad",

  // Approval / apply flow: approved is INTERMEDIARY (signed off, not yet
  // executed) — amber. Green is reserved for applied, when the write happened.
  approved: "pending",
  applied: "good",
  paid: "good",

  // Deal forecast
  pipeline: "neutral",
  best_case: "pending",
  commit: "good",
  closed_won: "good",
  closed_lost: "bad",
  omit: "neutral",
  on_track: "good",
  no_target: "neutral",

  // ABM / engagement
  target: "neutral",
  engaged: "pending",
  opportunity: "pending",
  customer: "good",
  tier_1: "bad",
  tier_2: "pending",
  tier_3: "neutral",

  // Lead routing + grades
  round_robin: "neutral",
  weighted: "neutral",
  territory_based: "neutral",
  skill_based: "neutral",
  hot: "bad",
  warm: "pending",
  cold: "neutral",

  // Magnitudes
  high: "good",
  medium: "pending",
  low: "neutral",
};

function formatLabel(status: string): string {
  return status.replace(/_/g, " ");
}

interface StatusBadgeProps {
  status: string;
  label?: string;
  className?: string;
}

export function StatusBadge({ status, label, className }: StatusBadgeProps) {
  const tone = STATUS_TONES[status] ?? "neutral";
  return (
    <span
      className={cn(
        "inline-flex rounded-sm px-2 py-0.5 text-xs font-medium",
        TONE_STYLES[tone],
        className,
      )}
    >
      {label ?? formatLabel(status)}
    </span>
  );
}
