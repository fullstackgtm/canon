import type { Doc, Id } from "../../_generated/dataModel";
import { BODY_MAX, SUBJECT_MAX, validAddress } from "../email/compose";
import { createUnipileClient, UnipileError } from "../linkedin/unipile";
import { deliveryMode, type Delivery } from "./adapters";
import type { P4PreparedEmail, P4PreparedManifestEmail, P4PreparedOwnerEmail } from "./mailboxTypes";
import { unsubscribeTokenShape } from "./unsubscribe";

export type P4MailboxDelivery = {
  prepared: P4PreparedEmail | P4PreparedManifestEmail | P4PreparedOwnerEmail;
  account: Pick<Doc<"emailAccounts">, "_id" | "orgId" | "userId" | "address" | "status" | "unipileAccountId">;
  emailSendId: Id<"emailSends">;
};
const failed = (error: string): Delivery => ({ ok: false, error, retry: false });
const unknown = (): Delivery => ({ ok: false, error: "The mailbox provider did not confirm delivery. Reconcile this attempt before any further send.", retry: false, unknown: true });
const headerSafe = (value: string, max: number) => typeof value === "string" && value.trim().length > 0 && value.length <= max && !/[\x00-\x1f\x7f\x85\u2028\u2029]/.test(value);
const canonicalAddress = (value: string) => headerSafe(value, 254) && validAddress(value) && value === value.trim().toLowerCase();

function providerEnv() {
  const apiKey = process.env.UNIPILE_API_KEY, dsn = process.env.UNIPILE_DSN;
  if (!apiKey || !/^[\x21-\x7e]{1,4096}$/.test(apiKey) || !dsn || dsn.length > 255
    || !/^(?:https:\/\/)?[a-z0-9-]+\.unipile\.com(?::\d{2,5})?\/?$/i.test(dsn)) return null;
  try { return { apiKey, dsn: new URL(`https://${dsn.replace(/^https:\/\//i, "")}`).host }; }
  catch { return null; }
}

export function mailboxTransportProblem(account: P4MailboxDelivery["account"]): string | null {
  if (!headerSafe(account.unipileAccountId, 250)) return "A live mailbox linkage is required.";
  const standIn = account.unipileAccountId.startsWith("local-");
  if (deliveryMode() === "sink") return standIn ? null : "A sink cannot deliver through a real mailbox.";
  if (standIn) return "A stand-in mailbox cannot deliver from a live deployment.";
  return providerEnv() ? null : "Mailbox delivery needs valid UNIPILE_API_KEY and UNIPILE_DSN configuration.";
}

function complianceHeaders(p: P4MailboxDelivery["prepared"], mode: "live" | "sink") {
  const headers = p.delivery.headers;
  if (!headers || !Array.isArray(headers.references) || p.thread !== null || headers.inReplyTo !== null || headers.references.length !== 0
    || Object.keys(headers).some((key) => !["listUnsubscribe", "listUnsubscribePost", "inReplyTo", "references"].includes(key))
    || headers.listUnsubscribePost !== "List-Unsubscribe=One-Click") return null;
  const value = headers.listUnsubscribe;
  if (!value || !headerSafe(value, 2500) || !value.startsWith("<") || !value.endsWith(">")) return null;
  try {
    const raw = value.slice(1, -1), url = new URL(raw), site = new URL(process.env.CONVEX_SITE_URL ?? "");
    const local = mode === "sink" && url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname);
    const token = url.searchParams.get("token");
    if ((!local && url.protocol !== "https:") || url.username || url.password || url.hash || url.pathname !== "/outbound/unsubscribe"
      || site.username || site.password || site.pathname !== "/" || site.search || site.hash
      || url.origin !== site.origin || [...url.searchParams.keys()].length !== 1 || !token || !unsubscribeTokenShape(token) || raw !== url.href
      || ("unsubscribe" in p && (!p.unsubscribe || p.unsubscribe.url !== raw || p.unsubscribe.token !== token))) return null;
    return { listUnsubscribe: value, listUnsubscribePost: headers.listUnsubscribePost };
  } catch { return null; }
}

export async function sendMailboxEmail(input: P4MailboxDelivery, fetchImpl: typeof fetch = fetch): Promise<Delivery> {
  const { prepared: p, account, emailSendId } = input, mode = deliveryMode();
  const personal = "kind" in p && p.kind === "owner.exact-email.v1" && p.purpose === "manual_action";
  const headers = personal ? null : complianceHeaders(p, mode), d = p.delivery;
  if (personal ? p.thread !== null || d.headers.inReplyTo !== null || d.headers.references.length !== 0 || d.headers.listUnsubscribe !== null || d.headers.listUnsubscribePost !== null : !headers) return failed("Unthreaded frozen RFC8058 compliance material is required for mailbox delivery.");
  if (account._id !== p.sender.id || account.orgId !== p.orgId || account.userId !== p.sender.ownerId || account.status !== "ok"
    || !headerSafe(account.address, 254) || !canonicalAddress(p.sender.address) || account.address.trim().toLowerCase() !== p.sender.address || !canonicalAddress(p.recipient.address)
    || !headerSafe(account.unipileAccountId, 250) || !headerSafe(emailSendId, 255)
    || !headerSafe(d.subject, SUBJECT_MAX) || typeof d.text !== "string" || !d.text.trim() || d.text.length > BODY_MAX || d.text.includes("\0")
    || typeof d.html !== "string" || !d.html.trim() || d.html.length > 6 * BODY_MAX + 4096 || d.html.includes("\0")) return failed("The claimed mailbox or frozen delivery binding is invalid.");
  const problem = mailboxTransportProblem(account);
  if (problem) return failed(problem);
  if (mode === "sink") return { ok: true, providerId: `local-${emailSendId}` };
  const env = providerEnv();
  if (!env) return failed("Mailbox delivery needs valid UNIPILE_API_KEY and UNIPILE_DSN configuration.");
  try {
    const { providerId } = await createUnipileClient({ ...env, fetchImpl, requestTimeoutMs: 20_000 }).sendMailboxEmail(account.unipileAccountId, {
      to: p.recipient.address, subject: d.subject, html: d.html, headers, idempotencyKey: emailSendId,
    });
    return providerId ? { ok: true, providerId } : unknown();
  } catch (cause) {
    if (cause instanceof UnipileError && cause.type === "canon/mail_refused") {
      return failed(`The mailbox provider refused delivery (HTTP ${cause.status}).`);
    }
    return unknown();
  }
}
