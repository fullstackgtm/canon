/** The kinds of field whose values open as links: an email writes to, a phone calls, a web address opens. */
export type ContactKind = "emails" | "phones" | "links";

const EMAIL = /^[^\s@?#&/:;,<>"']+@[^\s@?#&/:;,<>"']+\.[^\s@?#&/:;,<>"']+$/;
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/**
 * The href a stored email, phone or web address opens, or null when the value is not one that is safe to open:
 * a web address must be http or https (one without a scheme is https), so a stored `javascript:` value stays text.
 */
export function contactHref(kind: ContactKind, value: string): string | null {
  const v = value.trim();
  if (kind === "emails") return EMAIL.test(v) ? `mailto:${v}` : null;
  if (kind === "phones") {
    const [main, ext] = v.split(/\s*(?:x|ext\.?)\s*/i);
    const digits = (main.trim().startsWith("+") ? "+" : "") + main.replace(/\D/g, "");
    if (digits.replace("+", "").length < 4) return null;
    return `tel:${digits}${ext && /^\d{1,6}$/.test(ext) ? `;ext=${ext}` : ""}`;
  }
  try {
    const url = new URL(SCHEME.test(v) ? v : `https://${v}`);
    return (url.protocol === "https:" || url.protocol === "http:") && url.hostname.includes(".") ? url.href : null;
  } catch {
    return null;
  }
}
