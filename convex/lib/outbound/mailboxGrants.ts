import type { Doc, Id } from "../../_generated/dataModel";
import type { QueryCtx } from "../../_generated/server";
import { roleIn } from "../../permissions";
import { hmacHex } from "../agents/grants";
import { installedModule, isEnabled, manifestOf } from "../modules/packages";
import { derivedSecret } from "../operatorConfig";
import { normalizeSuppression } from "../suppressions/domain";
import type { ModuleManifest } from "../../../modules/kernel/manifest.ts";
import type { TemplateDecl } from "../../../modules/kernel/outbound.ts";
import { readSq1TemplateSet } from "./sq1Templates";

export type P4SenderRef = Id<"emailAccounts">;
export type P4GrantRef = Id<"mailboxSendGrants">;
type Grant = Doc<"mailboxSendGrants">;
export type P4OwnerGrantTerms = Pick<Grant, "version" | "orgId" | "moduleId" | "ownerId" | "senderId" | "mailboxLinkHash" | "template" | "maxPerDay" | "expiresAt" | "createdAt"> & { grantId: P4GrantRef };
type EmailTemplate = Extract<TemplateDecl, { channel: "email" }>;
export const MAILBOX_GRANT_MAX_DAYS = 90;
export const MAILBOX_GRANT_MAX_PER_DAY = 100;
export const MAILBOX_GRANT_DAY_MS = 86_400_000;
export const mailboxGrantKey = () => derivedSecret("outbound-mailbox-grant.v1");

export const mailboxGrantTerms = (g: Grant): P4OwnerGrantTerms => ({
  version: g.version, grantId: g._id, orgId: g.orgId, moduleId: g.moduleId, ownerId: g.ownerId, senderId: g.senderId,
  mailboxLinkHash: g.mailboxLinkHash, template: g.template, maxPerDay: g.maxPerDay, expiresAt: g.expiresAt, createdAt: g.createdAt,
});
const canonicalTerms = (t: P4OwnerGrantTerms) => JSON.stringify([
  "canon.outbound.mailbox-grant.v1", t.version, t.grantId, t.orgId, t.moduleId, t.ownerId, t.senderId, t.mailboxLinkHash,
  t.template.kind === "manifest" ? [t.template.kind, t.template.name, t.template.hash] : [t.template.kind, t.template.launchId, t.template.hash], t.maxPerDay, t.expiresAt, t.createdAt,
]);
export const signMailboxGrant = (terms: P4OwnerGrantTerms, key: string) => hmacHex(key, canonicalTerms(terms));
const hash = async (value: unknown) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value)))), (b) => b.toString(16).padStart(2, "0")).join("");

export function grantEligibleTemplate(t: TemplateDecl): t is EmailTemplate {
  return t.channel === "email" && t.subject.trim().length > 0 && t.subject.length <= 200 && !/[\r\n]/.test(t.subject)
    && t.body.trim().length > 0 && t.body.length <= 5000
    && [t.subject, t.body].every((text) => !text.includes("{{") && !text.replace(/\{\$to\.(?:name|firstName|email)\}/g, "").includes("{$"));
}
export const manifestTemplateHash = (moduleId: string, name: string, t: EmailTemplate) => hash(["canon.outbound.manifest-template.v1", moduleId, name, t.channel, t.subject, t.body]);

export async function grantTemplates(moduleId: string, manifest: ModuleManifest) {
  const email = manifest.outbound?.email;
  if (!email?.from.includes("member_mailbox") || !email.kinds.some((kind) => kind === "personal" || kind === "automated")) return [];
  return Promise.all(Object.entries(manifest.templates ?? {}).flatMap(([name, t]) => grantEligibleTemplate(t)
    ? [manifestTemplateHash(moduleId, name, t).then((hash) => ({ name, hash, subject: t.subject, body: t.body }))] : []));
}
export async function canonicalManifestTemplate(ctx: QueryCtx, orgId: Id<"organizations">, moduleId: string, name: string) {
  const pkg = await installedModule(ctx, orgId, moduleId);
  if (!pkg || pkg.moduleId !== moduleId || !(await isEnabled(ctx, orgId, moduleId))) return null;
  return (await grantTemplates(moduleId, manifestOf(pkg))).find((t) => t.name === name) ?? null;
}

export async function liveMailboxOwner(ctx: QueryCtx, orgId: Id<"organizations">, ownerId: Id<"users">) {
  const owner = await ctx.db.get(ownerId);
  return owner && !owner.isHidden && await roleIn(ctx, owner, orgId) !== null ? owner : null;
}

export async function mailboxLinkHash(account: Doc<"emailAccounts">): Promise<string | null> {
  const address = normalizeSuppression("email", account.address);
  if (account.status !== "ok" || !account.unipileAccountId.trim() || !address || !Number.isSafeInteger(account.connectedAt)) return null;
  return hash(["canon.outbound.mailbox-link.v1", account._id, account.orgId, account.userId, address, account.provider, account.unipileAccountId, account.connectedAt]);
}

export type MailboxGrantState = "live" | "revoked" | "expired" | "invalid" | "owner_unavailable" | "mailbox_changed" | "template_changed";
type MailboxGrantInspection = { state: "live"; preview: Pick<EmailTemplate, "subject" | "body"> }
  | { state: "live"; preview: null; templates: Array<{ stepKey: string; ordinal: number; variant: string; subject: string; body: string }> }
  | { state: Exclude<MailboxGrantState, "live">; preview: null };
export async function mailboxGrantSignatureValid(g: Grant) {
  const key = await mailboxGrantKey();
  if (!key || !/^[a-f0-9]{64}$/.test(g.signature)) return false;
  const expected = await signMailboxGrant(mailboxGrantTerms(g), key);
  let difference = 0;
  for (let i = 0; i < expected.length; i++) difference |= expected.charCodeAt(i) ^ g.signature.charCodeAt(i);
  return difference === 0;
}
export async function inspectMailboxGrant(ctx: QueryCtx, g: Grant, now: number): Promise<MailboxGrantInspection> {
  const fail = (state: Exclude<MailboxGrantState, "live">): MailboxGrantInspection => ({ state, preview: null });
  if (g.revokedAt !== undefined) return fail("revoked");
  if (g.version !== 1 || !Number.isInteger(g.maxPerDay) || g.maxPerDay < 1 || g.maxPerDay > MAILBOX_GRANT_MAX_PER_DAY
    || !Number.isSafeInteger(g.createdAt) || !Number.isSafeInteger(g.expiresAt) || g.createdAt > now || g.expiresAt <= g.createdAt
    || g.expiresAt - g.createdAt > MAILBOX_GRANT_MAX_DAYS * MAILBOX_GRANT_DAY_MS || !(await mailboxGrantSignatureValid(g))) return fail("invalid");
  if (g.expiresAt <= now) return fail("expired");
  if (!(await ctx.db.get(g.orgId)) || !(await liveMailboxOwner(ctx, g.orgId, g.ownerId))) return fail("owner_unavailable");
  const account = await ctx.db.get(g.senderId);
  if (!account || account.orgId !== g.orgId || account.userId !== g.ownerId || await mailboxLinkHash(account) !== g.mailboxLinkHash) return fail("mailbox_changed");
  if (g.template.kind === "manifest") {
    const template = await canonicalManifestTemplate(ctx, g.orgId, g.moduleId, g.template.name);
    if (!template || template.hash !== g.template.hash) return fail("template_changed");
    return { state: "live", preview: { subject: template.subject, body: template.body } };
  }
  const set = await readSq1TemplateSet(ctx, g.orgId, g.template.launchId, [g.ownerId]);
  if (!set || set.launch.moduleId !== g.moduleId || set.launch.templateSetHash !== g.template.hash || !set.launch.approvedSenderRefs.includes(g.senderId)) return fail("template_changed");
  return { state: "live", preview: null, templates: set.preview };
}

export async function readManifestMailboxGrant(ctx: QueryCtx, binding: { grantId: P4GrantRef; orgId: Id<"organizations">; moduleId: string; senderId: P4SenderRef }) {
  const grant = await ctx.db.get(binding.grantId);
  if (!grant || grant.template.kind !== "manifest" || grant.orgId !== binding.orgId || grant.moduleId !== binding.moduleId || grant.senderId !== binding.senderId) return null;
  const checked = await inspectMailboxGrant(ctx, grant, Date.now());
  return checked.state === "live" && checked.preview ? { terms: { ...mailboxGrantTerms(grant), template: grant.template }, preview: checked.preview } : null;
}
