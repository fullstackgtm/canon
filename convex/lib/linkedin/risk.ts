/**
 * The statement a user accepts before connecting LinkedIn. Its version is
 * stored with the acceptance; change the version whenever the text changes.
 * Shared by the Integrations card and the connect action.
 */
export const RISK_TEXT_VERSION = "2026-10-08";

export const RISK_TEXT = [
  "Canon will send connection invites and messages from your LinkedIn account on your behalf.",
  "LinkedIn's User Agreement does not allow automated activity. LinkedIn can warn, restrict or suspend accounts it believes are automated. You accept that risk for your own profile.",
  "Canon keeps your account within limits it recommends: daily and weekly caps, a warm-up for new accounts, sending only in your working hours with random gaps, and automatic pauses when acceptance drops or LinkedIn pushes back. You can tighten these at any time.",
  "Canon never sees your LinkedIn password. You log in on our provider's page, and you can disconnect at any time.",
] as const;
