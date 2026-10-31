import { toE164 } from "../dialer/telnyx";
import { publicIdentifierOf } from "../linkedin/cadence";

export const SUPPRESSION_KINDS = ["email", "domain", "phone", "linkedin"] as const;
export const SUPPRESSION_SOURCES = ["unsubscribe", "reply", "bounce", "manual", "dnc"] as const;
export const SUPPRESSION_PURPOSES = ["automated_outreach", "manual_action", "system_notice"] as const;
export type SuppressionKind = typeof SUPPRESSION_KINDS[number];
export type SuppressionSource = typeof SUPPRESSION_SOURCES[number];
export type SuppressionPurpose = typeof SUPPRESSION_PURPOSES[number];
export type SuppressionIdentifiers = { email?: string; phone?: string; linkedinUrl?: string };
export type SuppressionReason = { code: `suppression.${SuppressionSource}`; text: string };
export type ChannelSuppression = { blocked: boolean; code: SuppressionReason["code"] | null; text: string | null; reasons: SuppressionReason[] };
export type ChannelSuppressions = Record<"email" | "linkedin" | "voice", ChannelSuppression>;
export type SuppressionCause = { kind: SuppressionKind; source: SuppressionSource; state: "active" | "lifted" };

/** Exact domains only. No suffix matching, URL paths, ports or wildcard rules. */
export function normalizeSuppression(kind: SuppressionKind, raw: string): string | null {
  const value = raw.trim();
  if (value.length > 512) return null;
  if (kind === "phone") return toE164(value);
  if (kind === "linkedin") {
    const slug = publicIdentifierOf(value);
    return slug ? `https://www.linkedin.com/in/${encodeURIComponent(slug.toLowerCase())}` : null;
  }
  if (kind === "email") {
    const email = value.toLowerCase();
    return email.length <= 254 && /^[^\s@]+@[^\s@]+$/.test(email) && normalizeSuppression("domain", email.split("@")[1]) ? email : null;
  }
  if (!value || /[\s/:@?#*\\]/.test(value)) return null;
  try {
    const host = new URL(`https://${value}`).hostname.toLowerCase().replace(/\.$/, "");
    return host.length <= 253 && /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(host) ? host : null;
  } catch { return null; }
}

export function suppressionKeys(ids: SuppressionIdentifiers): Array<{ kind: SuppressionKind; value: string }> {
  const out: Array<{ kind: SuppressionKind; value: string }> = [];
  const email = ids.email ? normalizeSuppression("email", ids.email) : null;
  if (email) out.push({ kind: "email", value: email }, { kind: "domain", value: normalizeSuppression("domain", email.split("@")[1])! });
  for (const [kind, raw] of [["phone", ids.phone], ["linkedin", ids.linkedinUrl]] as const) {
    const value = raw ? normalizeSuppression(kind, raw) : null;
    if (value) out.push({ kind, value });
  }
  return out;
}

const TEXT: Record<SuppressionSource, string> = {
  unsubscribe: "Automated outreach is blocked by an unsubscribe.",
  reply: "Automated outreach is blocked after a reply.",
  bounce: "Do not contact: this channel has a bounce suppression.",
  manual: "Do not contact: this channel was blocked by your workspace.",
  dnc: "Do not contact: this channel is on your workspace's do-not-call list.",
};

/** No stored value, contact metadata or private admin note leaves this verdict. */
export function suppressionVerdict(causes: readonly SuppressionCause[], purpose: SuppressionPurpose): ChannelSuppressions {
  const result: ChannelSuppressions = {
    email: { blocked: false, code: null, text: null, reasons: [] },
    linkedin: { blocked: false, code: null, text: null, reasons: [] },
    voice: { blocked: false, code: null, text: null, reasons: [] },
  };
  for (const source of SUPPRESSION_SOURCES) {
    if ((source === "unsubscribe" || source === "reply") && purpose !== "automated_outreach") continue;
    for (const cause of causes) {
      if (cause.source !== source || cause.state !== "active") continue;
      const channel = result[cause.kind === "phone" ? "voice" : cause.kind === "linkedin" ? "linkedin" : "email"];
      if (channel.reasons.some((r) => r.code === `suppression.${source}`)) continue;
      const reason: SuppressionReason = { code: `suppression.${source}`, text: TEXT[source] };
      channel.reasons.push(reason);
      if (!channel.blocked) Object.assign(channel, { blocked: true, code: reason.code, text: reason.text });
    }
  }
  return result;
}
