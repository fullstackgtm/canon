import type { Id } from "../../_generated/dataModel";
import type { QueryCtx } from "../../_generated/server";
import { principalAccess } from "../../permissions";
import { composeProblem, validAddress, BODY_MAX, SUBJECT_MAX } from "../email/compose";
import { installedModule, manifestOf } from "../modules/packages";
import { senderReader } from "../modules/senders";
import { normalizeSuppression } from "../suppressions/domain";
import { suppressionFor } from "../suppressions/store";
import { policyForAutomatedEmail } from "./emailPolicy";
import { readManifestMailboxGrant, type P4GrantRef, type P4SenderRef } from "./mailboxGrants";
import { readCanonicalMailboxRecipient, type RecipientMergeField } from "./recipients";
import { mintUnsubscribeToken, verifyUnsubscribeToken } from "./unsubscribe";
import type { P4PreparedManifestEmail } from "./mailboxTypes";
import { siteOrigin, renderCompliantEmail } from "./emailRendering";
export type { P4PreparedManifestEmail } from "./mailboxTypes";

export type ManifestPreparationInput = {
  orgId: Id<"organizations">; moduleId: string; preparedBy: Id<"users">; contactId: string;
  senderId: P4SenderRef; grantId: P4GrantRef; requestedNotBefore: number;
};
type RefusalCode = "binding_invalid" | "grant_unavailable" | "module_unavailable" | "sender_unavailable" | "recipient_unavailable"
  | "policy_unavailable" | "site_unavailable" | "suppressed" | "render_invalid" | "token_unavailable" | "expired" | "drift";
type Refused = { state: "refused"; code: `outbound.preparation.${RefusalCode}`; text: string };
export type ManifestPreparationResult = { state: "prepared"; prepared: P4PreparedManifestEmail; recipientMergeFields: RecipientMergeField[] } | Refused;
export type ManifestRevalidationResult = { state: "valid" } | Refused;
const refuse = (code: RefusalCode, text: string): Refused => ({ state: "refused", code: `outbound.preparation.${code}`, text });
const digest = async (value: unknown) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value)))), (byte) => byte.toString(16).padStart(2, "0")).join("");
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const keys = (value: Record<string, unknown>, expected: readonly string[]) => Object.keys(value).length === expected.length && Object.keys(value).every((key) => expected.includes(key));
const time = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const text = (value: unknown): value is string => typeof value === "string";
const hex = (value: unknown) => text(value) && /^[a-f0-9]{64}$/.test(value);
const headerSafe = (value: string, max: number) => !!value.trim() && value.length <= max && !/[\x00-\x1f\x7f\x85\u2028\u2029]/.test(value);
const addressSafe = (value: string) => headerSafe(value, 254) && validAddress(value) && normalizeSuppression("email", value) === value;
const INPUT_KEYS = ["orgId", "moduleId", "preparedBy", "contactId", "senderId", "grantId", "requestedNotBefore"];
function validInput(value: ManifestPreparationInput) {
  return record(value) && keys(value, INPUT_KEYS) && [value.orgId, value.moduleId, value.preparedBy, value.contactId, value.senderId, value.grantId].every((id) => text(id) && id.length > 0 && id.length <= 250)
    && time(value.requestedNotBefore);
}

const mergeFields = (template: { subject: string; body: string }): RecipientMergeField[] =>
  (["name", "firstName", "email"] as const).filter((field) => [template.subject, template.body].some((value) => value.includes(`{$to.${field}}`)));
function fill(value: string, merge: Partial<Record<RecipientMergeField, string>>, max: number): string | null {
  let result = "", offset = 0;
  for (const match of value.matchAll(/\{\$to\.(name|firstName|email)\}/g)) {
    const selected = merge[match[1] as RecipientMergeField];
    if (selected === undefined) throw new Error("Canonical template merge field missing");
    const prefix = value.slice(offset, match.index);
    if (result.length + prefix.length + selected.length > max) return null;
    result += prefix + selected;
    offset = match.index + match[0].length;
  }
  const tail = value.slice(offset);
  return result.length + tail.length <= max ? result + tail : null;
}
const renderedHash = (delivery: P4PreparedManifestEmail["delivery"]) => digest(["canon.outbound.manifest-render.v1", delivery.subject, delivery.text, delivery.html,
  delivery.headers.listUnsubscribe, delivery.headers.listUnsubscribePost, delivery.headers.inReplyTo, delivery.headers.references]);
const bindingHash = (p: Omit<P4PreparedManifestEmail, "bindingHash">) => digest(["canon.outbound.prepared-manifest.v1", p.version, p.kind, p.purpose,
  p.orgId, p.moduleId, p.preparedBy, p.preparedAt, [p.recipient.contactId, p.recipient.streamId, p.recipient.address],
  [p.sender.id, p.sender.ownerId, p.sender.name, p.sender.address, p.sender.mailboxLinkHash], p.grantId, [p.template.kind, p.template.name, p.template.hash],
  p.companyStreamId, p.canonicalMergeHash, p.postalAddress, [p.unsubscribe.token, p.unsubscribe.url], p.renderedHash, p.requestedNotBefore, p.validUntil, p.thread]);

async function liveManifest(ctx: QueryCtx, input: ManifestPreparationInput) {
  if (!validInput(input)) return refuse("binding_invalid", "A closed canonical manifest preparation binding is required.");
  const orgId = ctx.db.normalizeId("organizations", input.orgId), senderId = ctx.db.normalizeId("emailAccounts", input.senderId);
  const grantId = ctx.db.normalizeId("mailboxSendGrants", input.grantId), preparedBy = ctx.db.normalizeId("users", input.preparedBy);
  if (!orgId || !senderId || !grantId || !preparedBy) return refuse("binding_invalid", "The canonical preparation identities are unavailable.");
  const grant = await readManifestMailboxGrant(ctx, { orgId, senderId, grantId, moduleId: input.moduleId });
  if (!grant) return refuse("grant_unavailable", "A live owner manifest grant and unchanged template are required.");
  const pkg = await installedModule(ctx, orgId, input.moduleId);
  const email = pkg ? manifestOf(pkg).outbound?.email : null;
  if (!pkg || pkg.moduleId !== input.moduleId || !email?.from.includes("member_mailbox") || !email.kinds.includes("automated")) {
    return refuse("module_unavailable", "The installed module must declare automated member-mailbox email.");
  }
  const fields = mergeFields(grant.preview);
  const recipient = await readCanonicalMailboxRecipient(ctx, { orgId, contactId: input.contactId, principalIds: [preparedBy, grant.terms.ownerId], mergeFields: fields });
  if (!recipient.allowed) return refuse("recipient_unavailable", recipient.refused.text);
  const access = await principalAccess(ctx, orgId, [preparedBy]);
  const sender = access ? await senderReader(ctx, orgId, access[0]).byId(senderId) : null;
  const address = sender ? normalizeSuppression("email", sender.address) : null;
  if (!sender || sender.ownerId !== grant.terms.ownerId || sender.status !== "ok" || !address || !addressSafe(address) || !headerSafe(sender.address, 254) || !headerSafe(sender.name, 200)) {
    return refuse("sender_unavailable", "A visible connected mailbox with safe sender headers is required.");
  }
  if (!addressSafe(recipient.binding.address)) return refuse("render_invalid", "The canonical destination cannot be used in an email header.");
  const policy = policyForAutomatedEmail(await ctx.db.get(orgId));
  if (policy.state === "refused") return refuse("policy_unavailable", policy.text);
  const origin = siteOrigin();
  if (!origin) return refuse("site_unavailable", "This deployment needs a trusted unsubscribe origin.");
  if ((await suppressionFor(ctx, orgId, { email: recipient.binding.address }, "automated_outreach")).email.blocked) {
    return refuse("suppressed", "The recipient is suppressed for automated outreach.");
  }
  const canonicalMergeHash = await digest(["canon.outbound.manifest-merge.v1", recipient.binding.contactId, recipient.binding.streamId,
    recipient.binding.address, fields.map((field) => [field, recipient.binding.merge[field]])]);
  return { state: "live" as const, grant, recipient: { contactId: recipient.binding.contactId, streamId: recipient.binding.streamId, address: recipient.binding.address },
    merge: recipient.binding.merge, canonicalMergeHash, sender: { id: sender.id, ownerId: sender.ownerId, name: sender.name, address, mailboxLinkHash: grant.terms.mailboxLinkHash },
    postalAddress: policy.policy.postalAddress, origin };
}

export async function prepareManifestEmail(ctx: QueryCtx, input: ManifestPreparationInput): Promise<ManifestPreparationResult> {
  const now = Date.now();
  if (!time(now)) return refuse("binding_invalid", "A valid server preparation time is required.");
  const live = await liveManifest(ctx, input);
  if (live.state === "refused") return live;
  const validUntil = live.grant.terms.expiresAt;
  if (input.requestedNotBefore >= validUntil) return refuse("expired", "The immutable requested time must precede the grant and compliance expiry.");
  const subject = fill(live.grant.preview.subject, live.merge, SUBJECT_MAX);
  const body = fill(live.grant.preview.body, live.merge, BODY_MAX)?.replace(/\r\n?/g, "\n");
  if (subject === null || body === undefined || !headerSafe(subject, SUBJECT_MAX) || composeProblem({ to: live.recipient.address, subject, body }) || body.includes("\0")) {
    return refuse("render_invalid", "The selected canonical values exceed safe email subject or body bounds.");
  }
  const minted = await mintUnsubscribeToken({ orgId: input.orgId, address: live.recipient.address, expiresAt: validUntil });
  if (!minted.ok) return refuse("token_unavailable", "This deployment cannot freeze valid unsubscribe material.");
  const url = `${live.origin}/outbound/unsubscribe?token=${encodeURIComponent(minted.token)}`;
  const delivery = renderCompliantEmail({ address: live.recipient.address, subject, body, postalAddress: live.postalAddress, url });
  if (!delivery) return refuse("render_invalid", "The frozen body and compliance footer exceed email bounds.");
  const prepared: Omit<P4PreparedManifestEmail, "bindingHash"> = { version: 1, kind: "manifest.automated-email.v1", purpose: "automated_outreach",
    orgId: input.orgId, moduleId: input.moduleId, preparedBy: input.preparedBy, preparedAt: now, recipient: live.recipient, sender: live.sender,
    grantId: input.grantId, template: { ...live.grant.terms.template }, companyStreamId: null, canonicalMergeHash: live.canonicalMergeHash, postalAddress: live.postalAddress,
    unsubscribe: { token: minted.token, url }, delivery, renderedHash: await renderedHash(delivery), requestedNotBefore: input.requestedNotBefore, validUntil, thread: null };
  return { state: "prepared", prepared: { ...prepared, bindingHash: await bindingHash(prepared) }, recipientMergeFields: mergeFields(live.grant.preview) };
}

function frozenShape(p: unknown): p is P4PreparedManifestEmail {
  if (!record(p) || !keys(p, ["version", "kind", "purpose", "orgId", "moduleId", "preparedBy", "preparedAt", "recipient", "sender", "grantId", "template", "companyStreamId", "canonicalMergeHash", "postalAddress", "unsubscribe", "delivery", "renderedHash", "bindingHash", "requestedNotBefore", "validUntil", "thread"])) return false;
  if (p.version !== 1 || p.kind !== "manifest.automated-email.v1" || p.purpose !== "automated_outreach" || p.companyStreamId !== null || p.thread !== null
    || !time(p.preparedAt) || !time(p.validUntil) || !time(p.requestedNotBefore) || ![p.orgId, p.moduleId, p.preparedBy, p.grantId, p.postalAddress].every(text)
    || ![p.canonicalMergeHash, p.renderedHash, p.bindingHash].every(hex)) return false;
  if (!record(p.recipient) || !keys(p.recipient, ["contactId", "streamId", "address"]) || !Object.values(p.recipient).every(text)
    || !record(p.sender) || !keys(p.sender, ["id", "ownerId", "name", "address", "mailboxLinkHash"]) || !Object.values(p.sender).every(text)
    || !record(p.template) || !keys(p.template, ["kind", "name", "hash"]) || p.template.kind !== "manifest" || !text(p.template.name) || !hex(p.template.hash)
    || !record(p.unsubscribe) || !keys(p.unsubscribe, ["token", "url"]) || !Object.values(p.unsubscribe).every(text)) return false;
  const d = p.delivery;
  return record(d) && keys(d, ["subject", "text", "html", "headers"]) && text(d.subject) && d.subject.length <= SUBJECT_MAX && text(d.text) && d.text.length <= BODY_MAX
    && text(d.html) && d.html.length <= 6 * BODY_MAX + 4096 && record(d.headers) && keys(d.headers, ["listUnsubscribe", "listUnsubscribePost", "inReplyTo", "references"])
    && text(d.headers.listUnsubscribe) && d.headers.listUnsubscribePost === "List-Unsubscribe=One-Click" && d.headers.inReplyTo === null && Array.isArray(d.headers.references) && d.headers.references.length === 0;
}

export async function revalidateManifestEmail(ctx: QueryCtx, frozen: P4PreparedManifestEmail): Promise<ManifestRevalidationResult> {
  if (!frozenShape(frozen)) return refuse("binding_invalid", "The frozen manifest email binding is malformed.");
  const now = Date.now();
  if (!time(now) || frozen.preparedAt > now || frozen.validUntil <= now || frozen.requestedNotBefore >= frozen.validUntil) return refuse("expired", "Frozen grant or unsubscribe material has expired.");
  if (await renderedHash(frozen.delivery) !== frozen.renderedHash || await bindingHash(frozen) !== frozen.bindingHash) return refuse("drift", "Frozen delivery or binding content changed.");
  const live = await liveManifest(ctx, { orgId: frozen.orgId, moduleId: frozen.moduleId, preparedBy: frozen.preparedBy, contactId: frozen.recipient.contactId,
    senderId: frozen.sender.id, grantId: frozen.grantId, requestedNotBefore: frozen.requestedNotBefore });
  if (live.state === "refused") return live;
  const same = (a: Record<string, unknown>, b: Record<string, unknown>) => Object.keys(a).every((key) => a[key] === b[key]);
  if (!same(live.recipient, frozen.recipient) || !same(live.sender, frozen.sender) || !same(live.grant.terms.template, frozen.template)
    || live.canonicalMergeHash !== frozen.canonicalMergeHash || live.postalAddress !== frozen.postalAddress || frozen.validUntil > live.grant.terms.expiresAt) {
    return refuse("drift", "Canonical recipient, sender, template or postal footer changed; prepare a fresh email.");
  }
  const verified = await verifyUnsubscribeToken(frozen.unsubscribe.token);
  const url = `${live.origin}/outbound/unsubscribe?token=${encodeURIComponent(frozen.unsubscribe.token)}`;
  if (!verified || verified.terms.orgId !== frozen.orgId || verified.terms.address !== frozen.recipient.address || verified.terms.expiresAt !== frozen.validUntil
    || verified.terms.issuedAt < frozen.preparedAt || frozen.unsubscribe.url !== url || frozen.delivery.headers.listUnsubscribe !== `<${url}>`) {
    return refuse("token_unavailable", "The frozen unsubscribe material is no longer valid for this deployment and recipient.");
  }
  return { state: "valid" };
}
