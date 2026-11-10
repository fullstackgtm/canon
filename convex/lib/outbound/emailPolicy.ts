import type { Doc } from "../../_generated/dataModel";

export const DEFAULT_RECIPIENT_WEEKLY_CAP = 3;
export function normalizedPostalAddress(raw: string): string | null {
  if (typeof raw !== "string" || raw.length > 2000 || /[<>\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(raw)) return null;
  const address = raw.replace(/\r\n?/g, "\n").replace(/\t/g, " ").split("\n").map((line) => line.trim()).join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return address.length <= 500 ? address : null;
}
export const validRecipientWeeklyCap = (cap: number) => Number.isInteger(cap) && cap >= 1 && cap <= DEFAULT_RECIPIENT_WEEKLY_CAP;

export function policyForAutomatedEmail(org: Pick<Doc<"organizations">, "outboundEmailPolicy" | "timezone"> | null) {
  const address = org?.outboundEmailPolicy?.postalAddress;
  const postalAddress = typeof address === "string" ? normalizedPostalAddress(address) : null;
  const recipientWeeklyCap = org?.outboundEmailPolicy?.recipientWeeklyCap ?? DEFAULT_RECIPIENT_WEEKLY_CAP;
  if (!org || !postalAddress || !validRecipientWeeklyCap(recipientWeeklyCap)) {
    return { state: "refused" as const, code: "outbound.email_policy_unavailable", text: "Automated email requires a configured workspace postal address and recipient cap." };
  }
  return { state: "allow" as const, policy: { postalAddress, recipientWeeklyCap, timezone: org.timezone } };
}
