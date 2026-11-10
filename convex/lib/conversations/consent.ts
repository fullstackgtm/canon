/**
 * What a user agrees to when they turn on "Read my messages" (docs/conversation-intake.md). Its version is
 * stored with the consent; change the version whenever the text changes. Shared by the settings card and
 * conversations.setIntake, the way lib/linkedin/risk.ts is for connecting.
 */
export const INTAKE_TEXT_VERSION = "2026-10-24";

export const INTAKE_TEXT = [
  "Canon reads your 1:1 LinkedIn conversations with people outside your team: the last 90 days now, and new messages as they arrive. Group chats and spam are skipped.",
  "It keeps the message text, so what it later suggests for your records can quote the conversation.",
  "You, and teammates whose role may read your activity, see the text. Everyone else sees only that a conversation happened.",
  "A conversation with someone who isn't in Canon creates nothing; at most it suggests them as a contact.",
  "Turn this off at any time. \"Delete what was read\" then removes the stored text.",
] as const;


/** The same for a linked Gmail inbox (CI2). */
export const EMAIL_INTAKE_TEXT_VERSION = "2026-10-24-email";

export const EMAIL_INTAKE_TEXT = [
  "Canon reads the email in this inbox, received and sent, with people outside your team: the last 90 days now, and new mail as it arrives. Newsletters, automated mail and bulk sends are skipped.",
  "It keeps the text of each email, without the quoted history, so what it later suggests for your records can quote the thread.",
  "You, and teammates whose role may read your activity, see the text. Everyone else sees only that an email was sent or received.",
  "An email with someone who isn't in Canon creates nothing; at most it suggests them as a contact.",
  "Turn this off at any time. \"Delete what was read\" then removes the stored text.",
] as const;

/** The consent text and version a channel's toggle shows and conversations.setIntake checks. */
export const INTAKE_CONSENT = {
  linkedin: { version: INTAKE_TEXT_VERSION, text: INTAKE_TEXT },
  email: { version: EMAIL_INTAKE_TEXT_VERSION, text: EMAIL_INTAKE_TEXT },
} as const;
