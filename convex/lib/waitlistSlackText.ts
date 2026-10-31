// Public input: escaping &<> stops <!channel> or <@U…> mentions from reaching Slack.
const plain = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function waitlistSlackText(raw: { email: string; domain: string; role?: string; teamSize?: string }) {
  const lead = { email: plain(raw.email), domain: plain(raw.domain), role: raw.role && plain(raw.role), teamSize: raw.teamSize && plain(raw.teamSize) };
  const details = [lead.role, lead.teamSize && `team ${lead.teamSize}`].filter(Boolean).join(" · ");
  return `New CanonCRM waitlist signup: ${lead.email} (researched ${lead.domain})${details ? ` — ${details}` : ""}`;
}
