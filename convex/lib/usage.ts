import { TREG_EMAIL_ENDPOINT } from "./emailFinder.ts";
import { TREG_PHONE_ENDPOINT } from "./phoneFinder.ts";

/** One metered call, as `providerCalls` stores it. */
export type ProviderCallRow = { endpoint: string; feature: string; costMicro: number; outcome: "hit" | "miss"; at: number };

/** A paid email hit is the one Hunter result that spends a monthly allowance slot. */
export const isPaidEmailHit = (call: Pick<ProviderCallRow, "endpoint" | "outcome">) =>
  call.endpoint === TREG_EMAIL_ENDPOINT && call.outcome === "hit";

/** A paid phone hit: a routed phone find that returned a number. */
export const isPaidPhoneHit = (call: Pick<ProviderCallRow, "endpoint" | "outcome">) =>
  call.endpoint === TREG_PHONE_ENDPOINT && call.outcome === "hit";

/** The UTC month `now` falls in: its first millisecond, and when the allowance resets. */
export function utcMonthWindow(now: number) {
  const d = new Date(now);
  return {
    start: Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1),
    resetsAt: Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1),
  };
}

const FEATURE_LABELS: Record<string, string> = {
  find_email: "Email reveals",
  find_phone: "Phone reveals",
  populate: "Account and contact population",
  populate_names: "Company name resolution",
};

const labelFor = (feature: string) =>
  FEATURE_LABELS[feature] ?? feature.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());

export type UsageCategory = { feature: string; label: string; calls: number; hits: number; costMicro: number };

/** Provider calls grouped by what the work was for, biggest spend first. Spend is USD millionths. */
export function categorizeProviderCalls(calls: ProviderCallRow[]): UsageCategory[] {
  const byFeature = new Map<string, UsageCategory>();
  for (const call of calls) {
    const row = byFeature.get(call.feature) ?? { feature: call.feature, label: labelFor(call.feature), calls: 0, hits: 0, costMicro: 0 };
    row.calls += 1;
    if (call.outcome === "hit") row.hits += 1;
    row.costMicro += call.costMicro;
    byFeature.set(call.feature, row);
  }
  return [...byFeature.values()].sort((a, b) => b.costMicro - a.costMicro || a.label.localeCompare(b.label));
}
