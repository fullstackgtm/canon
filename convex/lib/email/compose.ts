/**
 * One email a user writes to a contact and sends from a linked Gmail account
 * (docs/gmail-sending.md): the checks before sending, the daily cap and the
 * HTML body Unipile sends.
 *
 * Pure: no database access, no Node-only imports.
 */

/**
 * Emails one linked account may send in any 24 hours. Gmail's own limits are
 * 500 a day for a personal account and 2,000 for Workspace; one-off sends from
 * a contact page stay far below both, so a runaway loop or script stops here first.
 */
export const DAILY_SEND_CAP = 100;
export const DAY_MS = 24 * 60 * 60_000;

export const SUBJECT_MAX = 200;
export const BODY_MAX = 20_000;

const EMAIL = /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/;

export const validAddress = (address: string) => address.length <= 254 && EMAIL.test(address);

/** Why the email can't go, or null. */
export function composeProblem(email: { to: string | null; subject: string; body: string }): string | null {
  if (!email.to) return "This contact has no email address.";
  if (!validAddress(email.to)) return `${email.to} isn't a valid email address.`;
  if (!email.subject.trim()) return "Write a subject.";
  if (email.subject.length > SUBJECT_MAX) return `Keep the subject under ${SUBJECT_MAX} characters.`;
  if (/[\r\n]/.test(email.subject)) return "The subject must be one line.";
  if (!email.body.trim()) return "Write a message.";
  if (email.body.length > BODY_MAX) return `Keep the message under ${BODY_MAX.toLocaleString("en-US")} characters.`;
  return null;
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** The plain text the user wrote, as HTML: escaped, one paragraph per blank-line block, line breaks kept. */
export function bodyHtml(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .trim()
    .split(/\n{2,}/)
    .map((block) => `<p>${escapeHtml(block).replace(/\n/g, "<br>")}</p>`)
    .join("\n");
}
