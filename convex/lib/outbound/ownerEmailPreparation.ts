import type { Id } from "../../_generated/dataModel";
import type { QueryCtx } from "../../_generated/server";
import { principalAccess } from "../../permissions";
import { BODY_MAX, SUBJECT_MAX, bodyHtml, composeProblem, validAddress } from "../email/compose";
import { installedModule, isEnabled, manifestOf } from "../modules/packages";
import { personScope } from "../modules/scope";
import { senderReader } from "../modules/senders";
import { normalizeSuppression } from "../suppressions/domain";
import { suppressionFor } from "../suppressions/store";
import { emailHeaderSafe, renderCompliantEmail, siteOrigin } from "./emailRendering";
import { policyForAutomatedEmail } from "./emailPolicy";
import { mailboxLinkHash } from "./mailboxGrants";
import type { P4PreparedOwnerEmail } from "./mailboxTypes";
import { readCanonicalMailboxRecipient, type RecipientMergeField } from "./recipients";
import { mintUnsubscribeToken, verifyUnsubscribeToken } from "./unsubscribe";

export type OwnerEmailInput = {
  orgId: Id<"organizations">; moduleId: string; preparedBy: Id<"users">; contactId: string; senderId: Id<"emailAccounts">;
  template: string; source: { collection: string; key: string; version: number }; requestedNotBefore: number;
};
type Purpose = P4PreparedOwnerEmail["purpose"];
type UnboundOwnerEmail = Omit<Extract<P4PreparedOwnerEmail, { purpose: "manual_action" }>, "bindingHash">
  | Omit<Extract<P4PreparedOwnerEmail, { purpose: "automated_outreach" }>, "bindingHash">;
const WEEK = 7 * 86_400_000;
const refuse = (text = "The exact email's canonical source or live authority is unavailable.") => ({ state: "refused" as const, code: "outbound.owner_email.refused", text });
const time = (v: number) => Number.isSafeInteger(v) && v >= 0;
const keys = (v: object, expected: string[]) => Object.keys(v).length === expected.length && Object.keys(v).every((k) => expected.includes(k));
const hash = async (v: unknown): Promise<string> => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(v)))), (b) => b.toString(16).padStart(2, "0")).join("");
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => [k, canonical(v)]));
  return value;
}
const TOKEN = /\{\$(doc|to|sender)\.([a-zA-Z][a-zA-Z0-9_]*)\}/g;
function selections(subject: string, body: string) {
  const fields = new Set<string>();
  for (const value of [subject, body]) {
    const stripped = value.replace(TOKEN, (_, bind: string, field: string) => { fields.add(`${bind}.${field}`); return ""; });
    if (stripped.includes("{$") || stripped.includes("{{")) return null;
  }
  const selected = [...fields].sort();
  if (selected.length > 50 || selected.some((f) => f.startsWith("to.") && !["to.name", "to.firstName", "to.email"].includes(f)
    || f.startsWith("sender.") && !["sender.name", "sender.email"].includes(f))) return null;
  return selected;
}

export async function readOwnerEmailSource(ctx: QueryCtx, orgId: Id<"organizations">, moduleId: string, principalId: Id<"users">, source: { collection: string; key: string; version?: number }) {
  const user = await ctx.db.get(principalId);
  if (!user || !user.isActive || user.isHidden) return null;
  const scope = await personScope(ctx, orgId, principalId, moduleId);
  const doc = scope ? await scope.peek(source.collection, source.key) : null;
  return doc && (source.version === undefined || doc.version === source.version) ? doc : null;
}

export async function visibleOwnerEmailSource(ctx: QueryCtx, p: P4PreparedOwnerEmail, principalId: Id<"users">) {
  return !!(await readOwnerEmailSource(ctx, p.orgId, p.moduleId, principalId, { collection: p.source.collection, key: p.source.key }));
}

async function live(ctx: QueryCtx, input: OwnerEmailInput, purpose: Purpose) {
  if (!input || !keys(input, ["orgId", "moduleId", "preparedBy", "contactId", "senderId", "template", "source", "requestedNotBefore"])
    || !input.source || !keys(input.source, ["collection", "key", "version"]) || !time(input.source.version) || input.source.version < 1 || !time(input.requestedNotBefore)
    || [input.orgId, input.moduleId, input.preparedBy, input.contactId, input.senderId, input.template, input.source.collection, input.source.key].some((v) => typeof v !== "string" || !v || v.length > 250)) return refuse();
  if (!ctx.db.normalizeId("organizations", input.orgId) || !ctx.db.normalizeId("users", input.preparedBy) || !ctx.db.normalizeId("emailAccounts", input.senderId)) return refuse();
  const pkg = await installedModule(ctx, input.orgId, input.moduleId), manifest = pkg ? manifestOf(pkg) : null;
  const template = manifest?.templates?.[input.template], kind = purpose === "manual_action" ? "personal" : "automated";
  if (!pkg || pkg.pending || !(await isEnabled(ctx, input.orgId, input.moduleId)) || !manifest?.outbound?.email?.from.includes("member_mailbox")
    || !manifest.outbound.email.kinds.includes(kind) || !template || template.channel !== "email") return refuse();
  if (!time(pkg.epoch ?? 1) || (pkg.epoch ?? 1) < 1 || !pkg.version) return refuse();
  const selected = selections(template.subject, template.body);
  if (!selected) return refuse("Exact email templates support only explicit doc, recipient and sender fields without formatters.");
  const account = await ctx.db.get(input.senderId);
  if (!account || account.orgId !== input.orgId) return refuse();
  const recipientMergeFields = (["name", "firstName", "email"] as const).filter((field) => selected.includes(`to.${field}`));
  const recipient = await readCanonicalMailboxRecipient(ctx, { orgId: input.orgId, contactId: input.contactId, principalIds: [input.preparedBy, account.userId], mergeFields: recipientMergeFields });
  if (!recipient.allowed) return refuse();
  const access = await principalAccess(ctx, input.orgId, [input.preparedBy, account.userId]);
  const sender = access ? await senderReader(ctx, input.orgId, access[0]).byId(account._id) : null;
  const link = await mailboxLinkHash(account), address = normalizeSuppression("email", account.address);
  if (!sender || sender.ownerId !== account.userId || !link || !address || !validAddress(address) || !emailHeaderSafe(sender.name, 200)
    || !emailHeaderSafe(account.address, 254) || !emailHeaderSafe(recipient.binding.address, 254)) return refuse();
  const docs = await Promise.all([input.preparedBy, account.userId].map((principal) => readOwnerEmailSource(ctx, input.orgId, input.moduleId, principal, input.source)));
  if (docs.some((d) => !d) || JSON.stringify(canonical(docs[0]!.data)) !== JSON.stringify(canonical(docs[1]!.data))) return refuse();
  const doc = docs[0]!, values: Record<string, string> = {};
  for (const field of selected) {
    const [bind, name] = field.split(".");
    const value = bind === "doc" ? doc.data[name] : bind === "to" ? recipient.binding.merge[name as RecipientMergeField] : name === "name" ? sender.name : address;
    if (typeof value !== "string" || !value.trim() || value.includes("\0") || value.length > BODY_MAX) return refuse("A selected canonical text field is missing or exceeds email bounds.");
    values[field] = value;
  }

  const fill = (v: string, max: number) => {
    let result = "", offset = 0;
    for (const match of v.matchAll(TOKEN)) {
      const prefix = v.slice(offset, match.index), value = values[`${match[1]}.${match[2]}`];
      if (result.length + prefix.length + value.length > max) return null;
      result += prefix + value; offset = match.index + match[0].length;
    }
    return result.length + v.length - offset <= max ? result + v.slice(offset) : null;
  };
  const subject = fill(template.subject, SUBJECT_MAX), body = fill(template.body, BODY_MAX)?.replace(/\r\n?/g, "\n");
  if (subject === null || body === undefined || !emailHeaderSafe(subject, SUBJECT_MAX) || composeProblem({ to: recipient.binding.address, subject, body }) || body.includes("\0")) return refuse("The exact rendered email exceeds safe subject or body bounds.");
  if ((await suppressionFor(ctx, input.orgId, { email: recipient.binding.address }, purpose)).email.blocked) return { state: "refused" as const, code: "outbound.owner_email.suppressed", text: "The canonical recipient is suppressed for this email's purpose." };
  const policy = purpose === "automated_outreach" ? policyForAutomatedEmail(await ctx.db.get(input.orgId)) : null;
  const origin = purpose === "automated_outreach" ? siteOrigin() : null;
  if (policy?.state === "refused" || purpose === "automated_outreach" && !origin) return refuse("Automated exact emails need the current postal policy and trusted unsubscribe origin.");
  return { state: "live" as const, subject, body, origin, postalAddress: policy?.state === "allow" ? policy.policy.postalAddress : null,
    recipient: { contactId: recipient.binding.contactId, streamId: recipient.binding.streamId, address: recipient.binding.address },
    sender: { id: account._id, ownerId: account.userId, address, name: sender.name, mailboxLinkHash: link }, recipientMergeFields,
    template: { kind: "manifest" as const, name: input.template, version: pkg.version, epoch: pkg.epoch ?? 1, hash: await hash(["canon.outbound.owner-template.v1", input.moduleId, input.template, pkg.version, pkg.epoch ?? 1, template.subject, template.body]) },
    source: { collection: input.source.collection, key: input.source.key, version: input.source.version, hash: await hash(["canon.outbound.owner-source.v1", input.source.collection, input.source.key, doc.version, canonical(doc.data)]), fields: selected.filter((f) => f.startsWith("doc.")).map((f) => f.slice(4)) },
    canonicalMergeHash: await hash(["canon.outbound.owner-merge.v1", recipient.binding.contactId, recipient.binding.streamId, recipient.binding.address, selected.map((f) => [f, values[f]])]) };
}
export const ownerEmailRenderHash = (d: P4PreparedOwnerEmail["delivery"]) => hash(["canon.outbound.owner-render.v1", d.subject, d.text, d.html, d.headers.listUnsubscribe, d.headers.listUnsubscribePost, d.headers.inReplyTo, d.headers.references]);
const bindingHash = (p: Omit<P4PreparedOwnerEmail, "bindingHash">) => hash(["canon.outbound.owner-exact.v1", p.version, p.kind, p.purpose, p.orgId, p.moduleId, p.preparedBy, p.preparedAt,
  canonical(p.recipient), canonical(p.sender), canonical(p.template), canonical(p.source), p.recipientMergeFields, p.canonicalMergeHash, p.postalAddress, canonical(p.unsubscribe), p.renderedHash, p.requestedNotBefore, p.validUntil, p.thread]);
export async function ownerEmailFrozenValid(p: P4PreparedOwnerEmail) {
  return keys(p, ["version", "kind", "purpose", "orgId", "moduleId", "preparedBy", "preparedAt", "recipient", "sender", "companyStreamId", "template", "source", "recipientMergeFields", "canonicalMergeHash", "postalAddress", "unsubscribe", "delivery", "renderedHash", "bindingHash", "requestedNotBefore", "validUntil", "thread"])
    && p.kind === "owner.exact-email.v1" && p.version === 1 && p.thread === null && p.companyStreamId === null && time(p.preparedAt) && time(p.validUntil)
    && p.validUntil === p.preparedAt + WEEK && time(p.requestedNotBefore) && p.requestedNotBefore < p.validUntil
    && await ownerEmailRenderHash(p.delivery) === p.renderedHash && await bindingHash(p) === p.bindingHash;
}
async function prepare(ctx: QueryCtx, input: OwnerEmailInput, purpose: Purpose) {
  const now = Date.now();
  if (!time(now) || now > Number.MAX_SAFE_INTEGER - WEEK || input.requestedNotBefore >= now + WEEK) return refuse();
  const current = await live(ctx, input, purpose);
  if (current.state === "refused") return current;
  const { recipient, sender, template, source, recipientMergeFields, canonicalMergeHash } = current;
  const common = { version: 1 as const, kind: "owner.exact-email.v1" as const, orgId: input.orgId, moduleId: input.moduleId, preparedBy: input.preparedBy, preparedAt: now,
    recipient, sender, template, source, recipientMergeFields, canonicalMergeHash, companyStreamId: null, requestedNotBefore: input.requestedNotBefore, validUntil: now + WEEK, thread: null };
  let p: UnboundOwnerEmail;
  if (purpose === "manual_action") p = { ...common, purpose, postalAddress: null, unsubscribe: null, delivery: { subject: current.subject, text: current.body, html: bodyHtml(current.body),
    headers: { listUnsubscribe: null, listUnsubscribePost: null, inReplyTo: null, references: [] } }, renderedHash: "" };
  else {
    if (!current.origin || !current.postalAddress) return refuse();
    const token = await mintUnsubscribeToken({ orgId: input.orgId, address: recipient.address, expiresAt: common.validUntil });
    if (!token.ok) return refuse("This deployment cannot freeze signed unsubscribe material.");
    const url = `${current.origin}/outbound/unsubscribe?token=${encodeURIComponent(token.token)}`;
    const delivery = renderCompliantEmail({ address: recipient.address, subject: current.subject, body: current.body, postalAddress: current.postalAddress, url });
    if (!delivery) return refuse();
    p = { ...common, purpose, postalAddress: current.postalAddress, unsubscribe: { token: token.token, url }, delivery, renderedHash: "" };
  }
  p.renderedHash = await ownerEmailRenderHash(p.delivery);
  return { state: "prepared" as const, prepared: { ...p, bindingHash: await bindingHash(p) }, recipientMergeFields };
}

export const prepareOwnerPersonalEmail = (ctx: QueryCtx, input: OwnerEmailInput) => prepare(ctx, input, "manual_action");
export const prepareOwnerAutomatedEmail = (ctx: QueryCtx, input: OwnerEmailInput) => prepare(ctx, input, "automated_outreach");

export async function revalidateOwnerEmail(ctx: QueryCtx, p: P4PreparedOwnerEmail) {
  if (!(await ownerEmailFrozenValid(p)) || p.preparedAt > Date.now() || p.validUntil <= Date.now()) return refuse();
  const current = await live(ctx, { orgId: p.orgId, moduleId: p.moduleId, preparedBy: p.preparedBy, contactId: p.recipient.contactId, senderId: p.sender.id,
    template: p.template.name, source: { collection: p.source.collection, key: p.source.key, version: p.source.version }, requestedNotBefore: p.requestedNotBefore }, p.purpose);
  if (current.state === "refused") return current;
  for (const field of ["recipient", "sender", "template", "source", "recipientMergeFields", "canonicalMergeHash", "postalAddress"] as const) {
    if (JSON.stringify(canonical(current[field])) !== JSON.stringify(canonical(p[field]))) return refuse("The frozen email's source, recipient, sender or compliance policy changed.");
  }
  if (p.purpose === "automated_outreach") {
    const token = await verifyUnsubscribeToken(p.unsubscribe.token), url = `${current.origin}/outbound/unsubscribe?token=${encodeURIComponent(p.unsubscribe.token)}`;
    if (!token || token.terms.orgId !== p.orgId || token.terms.address !== p.recipient.address || token.terms.expiresAt !== p.validUntil
      || token.terms.issuedAt < p.preparedAt || p.unsubscribe.url !== url || p.delivery.headers.listUnsubscribe !== `<${url}>`
      || p.delivery.headers.listUnsubscribePost !== "List-Unsubscribe=One-Click") return refuse();
  } else if (p.unsubscribe !== null || p.postalAddress !== null || p.delivery.headers.listUnsubscribe !== null || p.delivery.headers.listUnsubscribePost !== null) return refuse();
  return { state: "valid" as const };
}
