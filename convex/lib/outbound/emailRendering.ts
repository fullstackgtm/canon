import { bodyHtml, BODY_MAX, SUBJECT_MAX, composeProblem } from "../email/compose";
import type { P4PreparedManifestEmail } from "./mailboxTypes";

export const emailHeaderSafe = (value: string, max: number) => typeof value === "string" && !!value.trim() && value.length <= max && !/[\x00-\x1f\x7f\x85\u2028\u2029]/.test(value);
export function siteOrigin(): string | null {
  const raw = process.env.CONVEX_SITE_URL?.trim();
  if (!raw || raw.length > 300) return null;
  try {
    const url = new URL(raw);
    if (url.username || url.password || url.pathname !== "/" || url.search || url.hash || (raw !== url.origin && raw !== `${url.origin}/`)) return null;
    const local = process.env.CANONCRM_LOCAL_STACK === "true" && process.env.FSGTM_ENABLE_DEMO_DATA === "true"
      && url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname);
    return url.protocol === "https:" || local ? url.origin : null;
  } catch { return null; }
}
export function renderCompliantEmail(input: { address: string; subject: string; body: string; postalAddress: string; url: string }): P4PreparedManifestEmail["delivery"] | null {
  const { subject, body, postalAddress, url } = input;
  if (!emailHeaderSafe(subject, SUBJECT_MAX) || composeProblem({ to: input.address, subject, body }) || body.includes("\0")) return null;
  const text = `${body}\n\n--\n${postalAddress}\nUnsubscribe: ${url}`;
  if (text.length > BODY_MAX) return null;
  const href = url.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  return { subject, text, html: `${bodyHtml(body)}\n${bodyHtml(postalAddress)}\n<p><a href="${href}">Unsubscribe</a></p>`,
    headers: { listUnsubscribe: `<${url}>`, listUnsubscribePost: "List-Unsubscribe=One-Click", inReplyTo: null, references: [] } };
}
