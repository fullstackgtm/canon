import { coreOf } from "../../../modules/kernel/schema";
import { canonicalJson } from "../../../modules/kernel/integrity.ts";
import { PUBLIC_GRANT, VISIT_HASH, type VisitArgs, type VisitFailure, type VisitFunction, type VisitResult, type VisitorWrite, type VisitUploadArgs, type VisitUploadTicket } from "../../../modules/kernel/visit.ts";
import { visitorFileFits } from "../../../modules/kernel/visitorFiles.ts";
import { rateLimitHit } from "../rateLimit.ts";
import { cuttingOver, shareDocs, shareFileInfo, recordVisitEvent, recordVisitorDay, writeShareDoc, shareUploadField, reserveVisitorUpload, visitorUploadRow, expiredVisitorUploads, releaseVisitorUpload, storeVisitorUpload, shareFileDownload } from "./scope";
import { holds, valueOf } from "../../../modules/kernel/machines.ts";
import { accessFor, workspaceMembers, roleBasesOf } from "../../permissions";
import { baseRole } from "../roles";
import { installedModule, isEnabled, manifestOf } from "./packages";
import { ConvexError } from "convex/values";
import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import type { ModuleScope } from "./scope";
import type { ShareDecl } from "../../../modules/kernel/manifest.ts";
import { isDevAuthBypassEnabled, userBelongsToOrg } from "../../lib";
import { projectShare, sha256, sharePayload, sharePolicyHash, shareReferences, shareWhereHolds, type SharePayload } from "./shares";
import { roomSource, type RoomAttribution } from "../../../modules/kernel/room.ts";
import type { RoomTarget } from "./roomAttribution";
import { appendObservations } from "../../observations";
import { visitorDomain, visitorEmail, visitorEmailAllowed } from "../../../modules/kernel/visitorIdentity.ts";
import { queueWorkspaceEmail } from "../outbound/queue";

const DAY = 86_400_000;
export const sharesEnabled = () => process.env.MODULE_SHARES === "on" || isDevAuthBypassEnabled();
const refuse = (message: string): never => { throw new ConvexError(message); };
const randomSecret = (bytes: number) => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(bytes)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function sellerShare(scope: ModuleScope, name: string, key: string, issuing = false): Promise<ShareDecl> {
  if (!sharesEnabled()) refuse("Customer links aren't on in this workspace yet");
  const share = scope.manifest.shares?.[name] ?? refuse("This module has no such share.");
  if (!share.issue.roles.includes(scope.role)) refuse("Your role cannot manage these links.");
  if (issuing && scope.agent) refuse("Only a person can issue a customer link.");
  if (!(await scope.peek(share.collection, key))) refuse("This doc is not yours to read.");
  return share;
}

export type IssueShareArgs = { share: string; key: string; to: { name?: string; email?: string; contactId?: string }; emails?: string[]; identity?: "link" | "email"; expiresDays?: number };
export type IssueSharePlan = { orgId: Id<"organizations">; userId: string; accessHash: string; epoch: number; version: number; createdAt: number; policyHash: string; target: RoomTarget | null };

export async function planShareLink(ctx: QueryCtx | MutationCtx, scope: ModuleScope, args: IssueShareArgs): Promise<IssueSharePlan> {
  const share = await sellerShare(scope, args.share, args.key, true);
  const root = (await scope.peek(share.collection, args.key))!;
  if (!shareWhereHolds(share.when, root.data)) refuse("This doc is not ready to share.");
  let target: RoomTarget | null = null;
  if (share.signals) {
    const source = roomSource(scope.manifest, share, root.data);
    target = { source, deal: null };
    if (source.deal) {
      const id = ctx.db.normalizeId("deals", source.deal), deal = id ? await ctx.db.get(id) : null;
      const entity = deal && deal.orgId === scope.orgId && deal.archivedAt === undefined ? await ctx.db.query("canonEntities").withIndex("by_orgId_projectionId", (q) => q.eq("orgId", scope.orgId).eq("projectionId", deal._id)).unique() : null;
      if (!deal || !entity || entity.projectionTable !== "deals" || entity.mergedInto || !deal.companyId) return refuse("The linked deal has no current canonical account.");
      target.deal = { id: deal._id, streamId: entity._id, companyId: deal.companyId };
    }
  }
  const user = await ctx.db.get(scope.userId as Id<"users">);
  if (!user) return refuse("The issuing member is no longer available.");
  return { orgId: scope.orgId, userId: scope.userId!, accessHash: await sha256(canonicalJson(await accessFor(ctx, user))), epoch: scope.epoch, version: root.version, createdAt: root.createdAt, policyHash: await sharePolicyHash(scope.manifest, share), target };
}

export async function issueShareLink(ctx: MutationCtx, scope: ModuleScope, args: IssueShareArgs, expected: IssueSharePlan, attribution: RoomAttribution | null) {
  const current = await planShareLink(ctx, scope, args);
  if (canonicalJson(current) !== canonicalJson(expected)) refuse("This share changed while issuing the link. Refresh and try again.");
  const share = scope.manifest.shares![args.share];
  const identity = args.identity ?? share.identity.default;
  if (!share.identity.allow.includes(identity)) refuse("This share does not allow that identity mode.");
  const days = args.expiresDays ?? share.expiresDays.default;
  if (!Number.isInteger(days) || days < 1 || days > share.expiresDays.max) refuse(`Choose 1 to ${share.expiresDays.max} days.`);
  const issuedTo: { name?: string; email?: string; contactId?: string } = {};
  for (const k of ["name", "email", "contactId"] as const) { const v = args.to[k]?.trim(); if (v) issuedTo[k] = v; }
  if (Object.values(issuedTo).some((v) => v!.length > 320)) refuse("Recipient details must be at most 320 characters.");
  const recipients = [...(issuedTo.email ? [issuedTo.email] : []), ...(args.emails ?? [])];
  if ((args.emails?.length ?? 0) > 25 || recipients.some((email) => !visitorEmail(email))) refuse("Choose up to 25 valid recipient emails.");
  const emails = [...new Set(recipients.map((email) => visitorEmail(email)!))];
  if (emails.length > 25) refuse("Choose up to 25 recipient emails.");
  if (emails[0]) issuedTo.email = emails[0];
  if (!Object.keys(issuedTo).length) refuse("Name a recipient for this link.");
  const declaredDomains = identity === "email" ? share.identity.domains ?? (attribution ? [attribution.domain] : []) : [];
  if (declaredDomains.length > 10 || declaredDomains.some((domain) => !visitorDomain(domain))) refuse("Choose up to 10 exact email domains.");
  const domains = [...new Set(declaredDomains.map((domain) => visitorDomain(domain)!))];
  if (identity === "email" && !emails.length && !domains.length) refuse("Email verification needs a recipient email or an allowed company domain.");
  const configured = process.env.NEXT_PUBLIC_SITE_URL ?? process.env.SITE_URL;
  const site = configured ?? (isDevAuthBypassEnabled() && process.env.CANON_SERVICE_JWT_ISSUER ? new URL(process.env.CANON_SERVICE_JWT_ISSUER).origin : null);
  const base = new URL(site ?? refuse("This deployment has no public site URL."));
  if (base.protocol !== "https:" && !(isDevAuthBypassEnabled() && base.protocol === "http:" && ["localhost", "127.0.0.1"].includes(base.hostname))) refuse("The public site URL must use HTTPS.");
  const token = randomSecret(32), publicId = randomSecret(16), now = Date.now(), expiresAt = now + days * DAY;
  await ctx.db.insert("moduleShareGrants", {
    orgId: scope.orgId, moduleId: scope.moduleId, share: args.share, policyHash: await sharePolicyHash(scope.manifest, share),
    collection: share.collection, key: args.key, rootCreatedAt: current.createdAt, tokenHash: await sha256(token), publicId,
    issuedTo, identity, ...(identity === "email" ? { emails, domains } : {}), expiresAt, issuedBy: scope.userId as Id<"users">, issuedAt: now, opens: 0, sessions: 0,
    ...(attribution ? { attribution } : {}), ...(share.issue.notify ? { expiryNoticeAt: Math.max(now, expiresAt - 3 * DAY) } : {}),
  });
  await scope.shareEvent(share, args.key, "share.issued", publicId);
  return { url: `${base.origin}/r#${token}`, publicId, expiresAt };
}

export async function shareLinks(ctx: QueryCtx, scope: ModuleScope, args: { share: string; key: string }) {
  if (!sharesEnabled()) return { enabled: false, links: [], expiresDays: null, identity: null };
  const share = await sellerShare(scope, args.share, args.key);
  const rows = await ctx.db.query("moduleShareGrants").withIndex("by_orgId_moduleId_collection_key", (q) => q.eq("orgId", scope.orgId).eq("moduleId", scope.moduleId).eq("collection", share.collection).eq("key", args.key)).take(1001);
  if (rows.length > 1000) refuse("This doc has too many links to list.");
  return { enabled: true, expiresDays: share.expiresDays, identity: share.identity, links: rows.filter((r) => r.share === args.share).map(({ publicId, issuedTo, identity, expiresAt, revokedAt, opens, lastOpenedAt }) => ({ publicId, issuedTo, identity, expiresAt, revokedAt: revokedAt ?? null, opens, lastOpenedAt: lastOpenedAt ?? null })) };
}

export async function changeShareLink(ctx: MutationCtx, scope: ModuleScope, args: { share: string; key: string; publicId: string; days?: number }, kind: "revoke" | "extend") {
  const share = await sellerShare(scope, args.share, args.key);
  const grant = (await ctx.db.query("moduleShareGrants").withIndex("by_publicId", (q) => q.eq("publicId", args.publicId)).unique()) ?? refuse("This link is not yours to change.");
  if (grant.orgId !== scope.orgId || grant.moduleId !== scope.moduleId || grant.share !== args.share || grant.collection !== share.collection || grant.key !== args.key) refuse("This link is not yours to change.");
  const now = Date.now();
  if (kind === "revoke") {
    if (grant.revokedAt === undefined) {
      await ctx.db.patch(grant._id, { revokedAt: now, expiryNoticeAt: undefined });
      await scope.shareEvent(share, args.key, "share.revoked", args.publicId);
    }
  } else {
    if (grant.revokedAt !== undefined) refuse("A revoked link cannot be extended.");
    if (!Number.isInteger(args.days) || args.days! < 1 || args.days! > share.expiresDays.max) refuse(`Choose 1 to ${share.expiresDays.max} days.`);
    const expiresAt = Math.min(Math.max(now, grant.expiresAt) + args.days! * DAY, now + share.expiresDays.max * DAY);
    await ctx.db.patch(grant._id, { expiresAt, ...(expiresAt !== grant.expiresAt && share.issue.notify ? { expiryNoticeAt: Math.max(now, expiresAt - 3 * DAY) } : {}) });
    await scope.shareEvent(share, args.key, "share.extended", args.publicId);
  }
  return { ok: true };
}

export async function previewSharePage(ctx: QueryCtx, scope: ModuleScope, args: { share: string; key: string; path?: string }): Promise<SharePayload | null> {
  if (!sharesEnabled()) refuse("Customer links aren't on in this workspace yet");
  const share = scope.manifest.shares?.[args.share] ?? refuse("This module has no such share.");
  const raw = await scope.shareDocs(share, args.key);
  if (!shareWhereHolds(share.when, raw[share.collection][0].data)) refuse("This doc is not ready to share.");
  const docs = projectShare(scope.manifest, share, args.key, raw);
  const refs = shareReferences(scope.manifest, share, docs);
  const members: SharePayload["members"] = {};
  for (const id of refs.members) {
    const uid = ctx.db.normalizeId("users", id), user = uid ? await ctx.db.get(uid) : null;
    if (user && !user.isHidden && await userBelongsToOrg(ctx, user, scope.orgId)) members[id] = Object.fromEntries(share.members.map((f) => [f, user[f] ?? null]));
  }
  const org = await ctx.db.get(scope.orgId);
  return sharePayload(scope.manifest, share, docs, org?.name ?? "Workspace", members, await scope.fileInfo(refs.files), args.path);
}


export type VisitorScope = {
  readonly grant: Doc<"moduleShareGrants">;
  readonly visitor: Doc<"moduleVisitors">;
  readonly share: ShareDecl;
  page(path?: string): Promise<SharePayload | null>;
  op(input: Extract<VisitorWrite, { kind: "op" }>): Promise<{ ok: true } | VisitFailure>;
  transition(input: Extract<VisitorWrite, { kind: "transition" }>): Promise<{ ok: true } | VisitFailure>;
  upload(input: VisitUploadArgs): Promise<VisitResult<VisitUploadTicket>>;
  file(id: string): Promise<Awaited<ReturnType<typeof shareFileDownload>>>;
  requestCode(email: string): Promise<{ ok: true } | VisitFailure>;
  verifyCode(code: string): Promise<{ ok: true } | VisitFailure>;
};

const dead = (): VisitFailure => ({ ok: false, status: 403 });
const limited = (): VisitFailure => ({ ok: false, status: 429 });
const decodeBytes = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=")), (c) => c.charCodeAt(0));
const decodeJson = (s: string) => JSON.parse(new TextDecoder().decode(decodeBytes(s))) as Record<string, unknown>;

async function verifyEnvelope(envelope: string, fn: VisitFunction, args: VisitArgs, now: number): Promise<{ ip: string; ua: string; nonce: string }> {
  try {
    if (envelope.length > 8192) throw new Error();
    const parts = envelope.split(".");
    if (parts.length !== 3) throw new Error();
    const [h, p, sig] = parts, header = decodeJson(h), c = decodeJson(p);
    const issuer = process.env.CANON_SERVICE_JWT_ISSUER;
    if (!issuer || header.alg !== "RS256" || header.typ !== "JWT" || typeof header.kid !== "string" ||
      typeof c.iss !== "string" || c.iss !== issuer || c.aud !== "canon-visit" || c.fn !== fn ||
      typeof c.iat !== "number" || !Number.isInteger(c.iat) || typeof c.exp !== "number" || !Number.isInteger(c.exp) ||
      c.exp <= c.iat || c.exp - c.iat > 120 || c.exp * 1000 <= now || c.iat * 1000 > now + 30_000 ||
      typeof c.args !== "string" || c.args !== await sha256(canonicalJson(args)) ||
      typeof c.ip !== "string" || !(c.ip === "unknown" || /^[0-9a-fA-F:.]{2,64}$/.test(c.ip)) ||
      typeof c.ua !== "string" || c.ua.length > 400 || typeof c.nonce !== "string" || !/^[A-Za-z0-9_-]{22}$/.test(c.nonce)) throw new Error();
    if ("tokenHash" in args ? c.tok !== args.tokenHash || c.sid !== undefined : c.sid !== args.sessionHash || c.tok !== undefined) throw new Error();
    const raw = process.env.CANON_SERVICE_JWKS ?? "";
    const keys = (JSON.parse(raw.startsWith("data:") ? atob(raw.slice(raw.indexOf(",") + 1)) : raw) as { keys: Array<JsonWebKey & { kid?: string }> }).keys;
    let verified = false;
    for (const jwk of keys.filter((k) => k.kty === "RSA" && k.kid === header.kid)) {
      const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
      if (await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, decodeBytes(sig), new TextEncoder().encode(`${h}.${p}`))) verified = true;
    }
    if (!verified) throw new Error();
    return { ip: c.ip, ua: c.ua, nonce: c.nonce };
  } catch { return refuse("This link has expired or was turned off"); }
}

async function counter(ctx: MutationCtx, key: string, limit: number, windowMs: number, now: number): Promise<boolean> {
  const row = await ctx.db.query("moduleRateLimits").withIndex("by_key", (q) => q.eq("key", key)).unique();
  const { allowed, next } = rateLimitHit(row, now, { limit, windowMs });
  if (allowed) {
    const value = { ...next, expiresAt: next.windowStart + windowMs };
    if (row) await ctx.db.patch(row._id, value);
    else await ctx.db.insert("moduleRateLimits", { key, ...value });
  }
  return allowed;
}

function verificationCode(): string {
  const word = new Uint32Array(1);
  do { crypto.getRandomValues(word); } while (word[0] >= 4_294_000_000);
  return String(word[0] % 1_000_000).padStart(6, "0");
}

const codeDigest = (row: { orgId: string; grantId: string; visitorId: string; email: string; salt: string }, code: string) =>
  sha256(canonicalJson([row.orgId, row.grantId, row.visitorId, row.email, row.salt, code]));

async function codeBudgets(ctx: MutationCtx, grant: Doc<"moduleShareGrants">, visitor: Doc<"moduleVisitors">, email: string, ip: string, kind: "request" | "attempt", now: number): Promise<boolean> {
  if (kind === "request" && !await counter(ctx, `code:resend:${visitor._id}`, 1, 60_000, now)) return false;
  const specs: Array<[string, number]> = [
    [`session:${visitor._id}`, kind === "request" ? 3 : 5],
    [`grant:${grant._id}`, kind === "request" ? 30 : 100],
    [`email:${grant.orgId}:${await sha256(email)}`, kind === "request" ? 5 : 10],
    [`ip:${ip}`, kind === "request" ? 20 : 50],
    [`workspace:${grant.orgId}`, kind === "request" ? 200 : 1000],
  ];
  for (const [key, limit] of specs) if (!await counter(ctx, `code:${kind}:${key}`, limit, 3_600_000, now)) return false;
  return true;
}

async function validGrant(ctx: MutationCtx, grant: Doc<"moduleShareGrants"> | null, now: number, rootOnly = false) {
  if (!sharesEnabled() || !grant || grant.revokedAt !== undefined || grant.expiresAt <= now) return null;
  if (!await ctx.db.get(grant.orgId)) return null;
  const issuer = await ctx.db.get(grant.issuedBy);
  if (!issuer || !issuer.isActive || issuer.isHidden) return null;
  const membership = await ctx.db.query("orgMemberships").withIndex("by_userId_orgId", (q) => q.eq("userId", grant.issuedBy).eq("orgId", grant.orgId)).unique();
  if (membership ? !membership.isActive : issuer.orgId !== grant.orgId) return null;
  const pkg = await installedModule(ctx, grant.orgId, grant.moduleId);
  if (!pkg || cuttingOver(pkg) || !await isEnabled(ctx, grant.orgId, grant.moduleId)) return null;
  const manifest = manifestOf(pkg), share = manifest.shares?.[grant.share];
  if (!share || share.collection !== grant.collection || await sharePolicyHash(manifest, share) !== grant.policyHash) return null;
  const raw = await shareDocs(ctx, grant.orgId, grant.moduleId, manifest, share, grant.key, rootOnly);
  const root = raw?.[share.collection]?.[0];
  if (!raw || !root || root.createdAt !== grant.rootCreatedAt || !shareWhereHolds(share.when, root.data)) return null;
  let attribution = grant.attribution ?? null;
  if (attribution) {
    const source = roomSource(manifest, share, root.data);
    if (canonicalJson(source) !== canonicalJson(attribution.source)) attribution = null;
    else if (attribution.deal) {
      const id = ctx.db.normalizeId("deals", attribution.deal.id), deal = id ? await ctx.db.get(id) : null;
      const entityId = ctx.db.normalizeId("canonEntities", attribution.deal.streamId), entity = entityId ? await ctx.db.get(entityId) : null;
      if (!deal || deal.orgId !== grant.orgId || deal.archivedAt !== undefined || deal.companyId !== attribution.accountId || !entity || entity.orgId !== grant.orgId || entity.mergedInto || entity.projectionTable !== "deals" || entity.projectionId !== deal._id) attribution = null;
    }
  }
  return { pkg, manifest, share, raw, attribution, docs: projectShare(manifest, share, grant.key, raw) };
}

async function notifyOwner(ctx: MutationCtx, grant: Doc<"moduleShareGrants">, resolved: NonNullable<Awaited<ReturnType<typeof validGrant>>>, message: string, now: number): Promise<void> {
  if (resolved.share.issue.notify !== "owner") return;
  const root = resolved.raw[grant.collection][0], id = ctx.db.normalizeId("users", root.owner ?? grant.issuedBy);
  const user = id ? await ctx.db.get(id) : null;
  if (!user || !user.isActive || user.isHidden || !await userBelongsToOrg(ctx, user, grant.orgId)) return;
  const membership = await ctx.db.query("orgMemberships").withIndex("by_userId_orgId", (q) => q.eq("userId", user._id).eq("orgId", grant.orgId)).unique();
  if (membership && !membership.isActive) return;
  await ctx.db.insert("notifications", { orgId: grant.orgId, userId: user._id, source: { kind: "module", moduleId: grant.moduleId, collection: grant.collection, key: grant.key }, message: message.slice(0, 300), at: now });
}

export async function expiryNotices(ctx: MutationCtx): Promise<number> {
  const now = Date.now();
  const due = await ctx.db.query("moduleShareGrants").withIndex("by_expiryNoticeAt", (q) => q.gte("expiryNoticeAt", 0).lte("expiryNoticeAt", now)).take(50);
  for (const grant of due) {
    await ctx.db.patch(grant._id, { expiryNoticeAt: undefined });
    const resolved = await validGrant(ctx, grant, now, true);
    if (resolved) await notifyOwner(ctx, grant, resolved, `${resolved.share.label}: a customer link expires in three days or less.`, now);
  }
  return due.length;
}

async function recordEngagement(ctx: MutationCtx, grant: Doc<"moduleShareGrants">, visitor: Doc<"moduleVisitors">, resolved: NonNullable<Awaited<ReturnType<typeof validGrant>>>, kind: "opened" | "acted", now: number, op?: string): Promise<void> {
  await recordVisitorDay(ctx, resolved.pkg, resolved.manifest, resolved.share, resolved.raw[grant.collection][0], { id: String(visitor._id), ...(visitor.name ? { name: visitor.name } : {}), ...(visitor.email ? { email: visitor.email } : {}), verified: visitor.verified }, kind, now);
  const pin = resolved.attribution;
  if (!resolved.share.signals || !pin) return;
  const day = new Date(now).toISOString().slice(0, 10), key = `room:${grant.publicId}:${visitor._id}:${day}:${kind}`;
  const contactId = visitor.verified && visitor.email?.trim().toLowerCase() === pin.contact?.email ? pin.contact?.id : undefined;
  const existing = contactId
    ? await ctx.db.query("observations").withIndex("by_orgId_subjectContactId_bodyKey", (q) => q.eq("orgId", grant.orgId).eq("subject.contactId", contactId).eq("body.key", key)).first()
    : await ctx.db.query("observations").withIndex("by_orgId_subjectDomain_bodyKey", (q) => q.eq("orgId", grant.orgId).eq("subject.domain", pin.domain).eq("body.key", key)).first();
  if (existing) return;
  await appendObservations(ctx, grant.orgId, contactId ? { object: "contact", contactId } : { object: "account", domain: pin.domain }, { kind: "pipeline", ref: "module-room" }, [{ observedAt: now, body: {
    type: "room", key, event: kind, module: grant.moduleId, share: grant.share, root: grant.key, grant: grant.publicId, visitor: String(visitor._id), day, accountId: pin.accountId,
    ...(pin.deal ? { dealStreamId: pin.deal.streamId } : {}), ...(op ? { op } : {}),
  } }]);
}

async function reserveUploadBudgets(ctx: MutationCtx, grant: Doc<"moduleShareGrants">, share: ShareDecl, bytes: number, now: number) {
  const specs = [
    { key: `uploads:grant:${grant._id}`, amount: 1, max: share.limits.uploadsPerDay, daily: true },
    { key: `uploadBytes:grant:${grant._id}`, amount: bytes, max: share.limits.uploadBytes, daily: false },
    { key: `uploads:workspace:${grant.orgId}`, amount: 1, max: 1000, daily: true },
    { key: `uploadBytes:workspace:${grant.orgId}`, amount: bytes, max: 1024 * 1024 * 1024, daily: true },
  ];
  const entries = [];
  for (const spec of specs) {
    const row = await ctx.db.query("moduleRateLimits").withIndex("by_key", (q) => q.eq("key", spec.key)).unique();
    const windowStart = spec.daily ? Math.floor(now / DAY) * DAY : 0;
    const count = (row?.windowStart === windowStart ? row.count : 0) + spec.amount;
    if (count > spec.max) return null;
    entries.push({ spec, row, windowStart, count });
  }
  for (const { spec, row, windowStart, count } of entries) {
    const value = { count, windowStart, expiresAt: spec.daily ? windowStart + DAY : 8_640_000_000_000_000 };
    if (row) await ctx.db.patch(row._id, value);
    else await ctx.db.insert("moduleRateLimits", { key: spec.key, ...value });
  }
  return entries.map(({ spec, windowStart }) => ({ key: spec.key, amount: spec.amount, windowStart }));
}

async function refundUpload(ctx: MutationCtx, row: NonNullable<Awaited<ReturnType<typeof visitorUploadRow>>>): Promise<void> {
  if (!row.visitorUpload || row.visitorUpload.state !== "reserved" || row.storageId) return;
  for (const budget of row.visitorUpload.budgets) {
    const counter = await ctx.db.query("moduleRateLimits").withIndex("by_key", (q) => q.eq("key", budget.key)).unique();
    if (counter?.windowStart === budget.windowStart) await ctx.db.patch(counter._id, { count: Math.max(0, counter.count - budget.amount) });
  }
  await releaseVisitorUpload(ctx, row);
}

export async function visitorUploadTicket(ctx: MutationCtx, ticket: string, secret: string) {
  const row = await visitorUploadRow(ctx, ticket), upload = row?.visitorUpload;
  if (!row || !upload || row.secret !== secret || !secret || upload.state === "released") return null;
  if (upload.state === "reserved" && upload.expiresAt <= Date.now()) { await refundUpload(ctx, row); return null; }
  if (upload.state === "stored" && upload.expiresAt <= Date.now()) return null;
  const visitor = await ctx.db.get(upload.visitorId), grant = await ctx.db.get(upload.grantId);
  const resolved = await validGrant(ctx, grant, Date.now());
  if (!visitor || !grant || !resolved || grant.identity === "email" && !visitor.verified || visitor.grantId !== grant._id || visitor.orgId !== row.orgId || visitor.sessionHash !== upload.sessionHash || grant.orgId !== row.orgId || grant.moduleId !== row.moduleId || grant.policyHash !== upload.policyHash || grant.rootCreatedAt !== upload.rootCreatedAt) return null;
  const target = JSON.parse(upload.target) as VisitUploadArgs["target"];
  const field = shareUploadField({ pkg: resolved.pkg, manifest: resolved.manifest, share: resolved.share, shareName: grant.share, rootKey: grant.key, tree: resolved.raw }, target);
  if (!field || field.collection !== upload.collection || field.generation !== upload.generation || !visitorFileFits(field.file, { ...row, digest: upload.digest })) return null;
  return row;
}

export async function finishVisitorUpload(ctx: MutationCtx, ticket: string, secret: string, storageId: Id<"_storage">) {
  const row = await visitorUploadTicket(ctx, ticket, secret);
  if (!row) return refuse("This upload could not be stored.");
  if (row.storageId) {
    if (row.storageId !== storageId) return refuse("This upload was already stored.");
    return { id: String(row._id), name: row.name, type: row.type, bytes: row.bytes };
  }
  return storeVisitorUpload(ctx, row, storageId);
}

export async function cancelVisitorUpload(ctx: MutationCtx, ticket: string, secret: string, attemptedBlob?: Id<"_storage">): Promise<void> {
  const row = await visitorUploadRow(ctx, ticket);
  if (attemptedBlob && row?.storageId !== attemptedBlob) await ctx.storage.delete(attemptedBlob);
  if (row && secret && row.secret === secret) await refundUpload(ctx, row);
}

export async function visitorScope(ctx: MutationCtx, envelope: string, fn: VisitFunction, args: VisitArgs): Promise<VisitResult<VisitorScope>> {
  const now = Date.now(), seen = await verifyEnvelope(envelope, fn, args, now);
  const consumeNonce = () => counter(ctx, `nonce:${seen.nonce}`, 1, 600_000, now);
  if (!sharesEnabled()) return dead();
  const consumed = await ctx.db.query("moduleRateLimits").withIndex("by_key", (q) => q.eq("key", `nonce:${seen.nonce}`)).unique();
  if (consumed && consumed.expiresAt > now) return dead();
  const expired = await ctx.db.query("moduleRateLimits").withIndex("by_expiresAt", (q) => q.lt("expiresAt", now)).take(20);
  for (const row of expired) await ctx.db.delete(row._id);
  const expiredCodes = await ctx.db.query("moduleVisitCodes").withIndex("by_expiresAt", (q) => q.lt("expiresAt", now)).take(20);
  for (const row of expiredCodes) await ctx.db.delete(row._id);
  let grant: Doc<"moduleShareGrants"> | null, visitor: Doc<"moduleVisitors"> | null = null;
  const ip = await sha256(seen.ip);
  if ("tokenHash" in args) {
    if (fn !== "visits:visitOpen" || !VISIT_HASH.test(args.tokenHash) || !VISIT_HASH.test(args.newSessionHash) || args.sessions.length > 100 || args.sessions.some((s) => !PUBLIC_GRANT.test(s.publicId) || !VISIT_HASH.test(s.sessionHash))) return dead();
    if (!await counter(ctx, "opens:deployment", 10_000, 3_600_000, now) || !await counter(ctx, `opens:ip:${ip}`, 30, 600_000, now)) return limited();
    const lock = await ctx.db.query("moduleRateLimits").withIndex("by_key", (q) => q.eq("key", `dead-lock:${ip}`)).unique();
    if (lock && lock.expiresAt > now) return limited();
    grant = await ctx.db.query("moduleShareGrants").withIndex("by_tokenHash", (q) => q.eq("tokenHash", args.tokenHash)).unique();
  } else {
    if (!["visits:visitPage", "visits:visitOp", "visits:visitTransition", "visits:visitUpload", "visits:visitFile", "visits:visitRequestCode", "visits:visitVerifyCode"].includes(fn) || !PUBLIC_GRANT.test(args.publicId) || !VISIT_HASH.test(args.sessionHash)) return dead();
    visitor = await ctx.db.query("moduleVisitors").withIndex("by_sessionHash", (q) => q.eq("sessionHash", args.sessionHash)).unique();
    grant = visitor ? await ctx.db.get(visitor.grantId) : null;
    if (!grant || grant.publicId !== args.publicId || visitor?.orgId !== grant.orgId) return dead();
  }
  const codeRequest = fn === "visits:visitRequestCode" || fn === "visits:visitVerifyCode";
  const resolved = await validGrant(ctx, grant, now, codeRequest || grant?.identity === "email" && !visitor?.verified);
  if (!grant || !resolved) {
    if ("tokenHash" in args && !await counter(ctx, `dead:${ip}`, 10, 600_000, now)) {
      await counter(ctx, `dead-lock:${ip}`, 1, 1_800_000, now);
      return limited();
    }
    return dead();
  }
  if (codeRequest && grant.identity !== "email") return dead();
  if (grant.identity === "email" && !visitor?.verified && !("tokenHash" in args) && !codeRequest) return { ...dead(), verificationRequired: true };
  if ("tokenHash" in args) {
    if (!await counter(ctx, `opens:workspace:${grant.orgId}`, 5000, 3_600_000, now)) return limited();
    const matches = args.sessions.filter((s) => s.publicId === grant.publicId);
    if (matches.length > 1) return dead();
    if (matches[0]) {
      visitor = await ctx.db.query("moduleVisitors").withIndex("by_sessionHash", (q) => q.eq("sessionHash", matches[0].sessionHash)).unique();
      if (visitor && (visitor.grantId !== grant._id || visitor.orgId !== grant.orgId)) visitor = null;
    }
    if (!visitor) {
      if (grant.sessions >= 25) return limited();
      const declared = grant.identity === "link" && grant.sessions > 0;
      if (declared && (!args.name?.trim() || !args.email?.trim())) return { ...dead(), identityRequired: true };
      if ((args.name?.length ?? 0) > 200 || (args.email?.length ?? 0) > 320 || declared && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(args.email!)) return dead();
      if (await ctx.db.query("moduleVisitors").withIndex("by_sessionHash", (q) => q.eq("sessionHash", args.newSessionHash)).unique()) return dead();
      if (!await consumeNonce()) return dead();
      const id = await ctx.db.insert("moduleVisitors", {
        orgId: grant.orgId, grantId: grant._id, sessionHash: args.newSessionHash, verified: false, declared,
        ...(declared ? { name: args.name!.trim(), email: args.email!.trim() } : grant.identity === "link" && grant.issuedTo.name ? { name: grant.issuedTo.name } : {}), firstAt: now, lastAt: now,
      });
      visitor = (await ctx.db.get(id))!;
      await ctx.db.patch(grant._id, { sessions: grant.sessions + 1 });
      if (grant.identity === "link") await notifyOwner(ctx, grant, resolved, `${visitor.name ?? "Visitor"} (unverified) opened ${resolved.share.label}.`, now);
    } else {
      if (!await consumeNonce()) return dead();
    }
    if (grant.identity === "link" || visitor.verified) {
      await ctx.db.patch(grant._id, { opens: grant.opens + 1, lastOpenedAt: now });
      await recordVisitEvent(ctx, { orgId: grant.orgId, moduleId: grant.moduleId, collection: grant.collection, key: grant.key }, { kind: "visitor", grant: grant.publicId, visitor: visitor._id, verified: visitor.verified }, "visit.opened");
    }
  } else if (codeRequest) {
    if (!await consumeNonce()) return dead();
  } else if (fn === "visits:visitPage" || fn === "visits:visitFile") {
    if (!visitor || !await counter(ctx, `reads:session:${visitor._id}`, 120, 60_000, now) || !await counter(ctx, `reads:grant:${grant.publicId}`, 2000, 3_600_000, now) || !await counter(ctx, `reads:workspace:${grant.orgId}`, 50_000, 3_600_000, now)) return limited();
    if (!await consumeNonce()) return dead();
  }
  if (!visitor) return dead();
  if (!codeRequest) await ctx.db.patch(visitor._id, { lastAt: now });
  const boundGrant = grant, boundVisitor = visitor;
  const label = boundVisitor.name ?? boundVisitor.email ?? "Visitor";
  async function write(input: VisitorWrite): Promise<{ ok: true } | VisitFailure> {
    if (fn !== (input.kind === "op" ? "visits:visitOp" : "visits:visitTransition")) return dead();
    if (!await counter(ctx, `writes:session:${boundVisitor._id}`, resolved!.share.limits.writesPerHour, 3_600_000, now) ||
      !await counter(ctx, `writes:grant:${boundGrant.publicId}`, 300, DAY, now) || !await counter(ctx, `writes:workspace:${boundGrant.orgId}`, 10_000, DAY, now)) return limited();
    const actor = { kind: "visitor" as const, grant: boundGrant.publicId, visitor: boundVisitor._id, verified: boundVisitor.verified, ...(boundVisitor.email ? { email: boundVisitor.email } : {}) };
    const written = await writeShareDoc(ctx, { pkg: resolved!.pkg, manifest: resolved!.manifest, share: resolved!.share, shareName: boundGrant.share, rootKey: boundGrant.key, tree: resolved!.raw,
      visitor: { id: boundVisitor._id, ...(boundVisitor.name ? { name: boundVisitor.name } : {}), ...(boundVisitor.email ? { email: boundVisitor.email } : {}), label, verified: boundVisitor.verified }, actor, evidence: { ip: seen.ip, userAgent: seen.ua },
      uploadOwner: { grantId: boundGrant._id, sessionHash: boundVisitor.sessionHash, policyHash: boundGrant.policyHash, rootCreatedAt: boundGrant.rootCreatedAt } }, input);
    if (!await consumeNonce()) refuse("This change could not be saved.");
    await recordEngagement(ctx, boundGrant, boundVisitor, resolved!, "acted", now, input.kind === "op" ? input.op : `${input.machine}.${input.transition}`);
    const sharedRootNotices = written.effects.some((fx) => fx.notify.some((r) => r !== null && typeof r === "object" && "shared" in r));
    const recipients = new Set<string>(), members = await workspaceMembers(ctx, boundGrant.orgId), bases = await roleBasesOf(ctx, boundGrant.orgId);
    for (const fx of written.effects) {
      if (fx.when && !await holds(fx.when, written.env.doc, written.env)) continue;
      for (const recipient of fx.notify) {
        if (sharedRootNotices && !(recipient !== null && typeof recipient === "object" && "shared" in recipient)) continue;
        if (recipient !== null && typeof recipient === "object" && "shared" in recipient) {
          const sh = recipient.shared, share = resolved!.share, manifest = resolved!.manifest;
          const spec = manifest.collections[share.collection].schema.value[sh.field], type = spec && coreOf(spec.fieldType);
          if (sh.from !== "root" || sh.field.includes(".") || !share.read[share.collection]?.fields.includes(sh.field) || type?.type !== "ref" || type.to !== "users") continue;
          const value = await valueOf(recipient, written.env);
          const member = typeof value === "string" ? members.find((m) => m.id === value) : undefined;
          if (!member) continue;
          const user = await ctx.db.get(member.id);
          if (user?.isActive && !user.isHidden && await userBelongsToOrg(ctx, user, boundGrant.orgId)) recipients.add(member.id);
        } else if (recipient !== null && typeof recipient === "object" && "role" in recipient) {
          for (const m of members) if (recipient.role.some((role) => role === baseRole(m.role, bases))) recipients.add(m.id);
        } else {
          const value = await valueOf(recipient, written.env);
          for (const id of Array.isArray(value) ? value : [value]) if (typeof id === "string") recipients.add(id);
        }
      }
    }
    const active = new Set<string>();
    for (const member of members) {
      const user = await ctx.db.get(member.id);
      if (user?.isActive && !user.isHidden && await userBelongsToOrg(ctx, user, boundGrant.orgId) && (!sharedRootNotices || recipients.has(member.id))) active.add(member.id);
    }
    const bucketKey = `notice:${boundVisitor._id}:${boundGrant.collection}:${boundGrant.key}`;
    const bucket = await ctx.db.query("moduleRateLimits").withIndex("by_key", (q) => q.eq("key", bucketKey)).unique();
    const continuing = !!bucket?.notice && bucket.windowStart + 300_000 > now;
    if (recipients.size || continuing) {
      const count = continuing ? bucket!.count + 1 : 1;
      const root = resolved!.docs[boundGrant.collection][0];
      const titleField = resolved!.manifest.collections[boundGrant.collection].title ?? "title";
      const title = typeof root.data[titleField] === "string" ? String(root.data[titleField]) : resolved!.share.label;
      const message = `${label}${boundVisitor.verified ? "" : " (unverified)"} · ${count} ${count === 1 ? "update" : "updates"} in ${title}`.slice(0, 300);
      const ids: Id<"notifications">[] = [];
      const notified = new Set<string>();
      for (const id of continuing ? bucket!.notice!.ids : []) {
        const notice = await ctx.db.get(id);
        if (notice && notice.orgId === boundGrant.orgId && active.has(notice.userId)) {
          await ctx.db.patch(id, { message }); ids.push(id); notified.add(notice.userId);
        }
      }
      for (const id of [...recipients].filter((id) => active.has(id) && !notified.has(id)).slice(0, 50 - ids.length)) {
        ids.push(await ctx.db.insert("notifications", { orgId: boundGrant.orgId, userId: id as Id<"users">, source: { kind: "module", moduleId: boundGrant.moduleId, collection: boundGrant.collection, key: boundGrant.key }, message, at: now }));
      }
      const value = { count, windowStart: continuing ? bucket!.windowStart : now, expiresAt: now + DAY, notice: { cause: continuing ? bucket!.notice!.cause : written.eventId, ids } };
      if (bucket) await ctx.db.patch(bucket._id, value);
      else await ctx.db.insert("moduleRateLimits", { key: bucketKey, ...value });
    }
    return { ok: true };
  }
  const scope: VisitorScope = { grant, visitor, share: resolved.share, op: write, transition: write,
    async requestCode(input) {
      if (fn !== "visits:visitRequestCode") return dead();
      if (boundVisitor.verified) return { ok: true };
      const email = visitorEmail(input);
      if (!await codeBudgets(ctx, boundGrant, boundVisitor, email ?? "invalid", ip, "request", now)) return limited();
      const previous = await ctx.db.query("moduleVisitCodes").withIndex("by_visitorId", (q) => q.eq("visitorId", boundVisitor._id)).unique();
      if (previous) await ctx.db.delete(previous._id);
      if (!email || !visitorEmailAllowed(email, boundGrant)) return { ok: true };
      const code = verificationCode(), salt = randomSecret(32);
      const binding = { orgId: boundGrant.orgId, grantId: boundGrant._id, visitorId: boundVisitor._id, email, salt };
      await ctx.db.insert("moduleVisitCodes", { ...binding, codeHash: await codeDigest(binding, code), expiresAt: Math.min(now + 600_000, boundGrant.expiresAt), tries: 0, state: "issued" });
      await queueWorkspaceEmail(ctx, { orgId: boundGrant.orgId, to: { address: email }, subject: "Your Canon verification code",
        body: `Your verification code is ${code}. It expires in 10 minutes. If you did not request it, ignore this email.`, cause: `visit-code:${boundVisitor._id}:${salt}` });
      return { ok: true };
    }, async verifyCode(code) {
      if (fn !== "visits:visitVerifyCode" || boundVisitor.verified) return dead();
      const row = await ctx.db.query("moduleVisitCodes").withIndex("by_visitorId", (q) => q.eq("visitorId", boundVisitor._id)).unique();
      if (!await codeBudgets(ctx, boundGrant, boundVisitor, row?.email ?? "missing", ip, "attempt", now)) return limited();
      if (!row || row.orgId !== boundGrant.orgId || row.grantId !== boundGrant._id || row.state !== "issued" || row.expiresAt <= now || row.tries >= 5) return dead();
      await ctx.db.patch(row._id, { tries: row.tries + 1 });
      if (!/^\d{6}$/.test(code) || await codeDigest(row, code) !== row.codeHash || !visitorEmailAllowed(row.email, boundGrant)) return dead();
      await ctx.db.patch(row._id, { state: "used" });
      const verified = { ...boundVisitor, verified: true, email: row.email, declared: true };
      await ctx.db.patch(boundVisitor._id, { verified: true, email: row.email, declared: true, lastAt: now });
      await ctx.db.patch(boundGrant._id, { opens: boundGrant.opens + 1, lastOpenedAt: now });
      await recordVisitEvent(ctx, { orgId: boundGrant.orgId, moduleId: boundGrant.moduleId, collection: boundGrant.collection, key: boundGrant.key }, { kind: "visitor", grant: boundGrant.publicId, visitor: boundVisitor._id, verified: true }, "visit.opened");
      await notifyOwner(ctx, boundGrant, resolved, `${verified.name ?? verified.email} (verified) opened ${resolved.share.label}.`, now);
      return { ok: true };
    },
    async upload(input) {
      if (fn !== "visits:visitUpload") return dead();
      const field = shareUploadField({ pkg: resolved.pkg, manifest: resolved.manifest, share: resolved.share, shareName: boundGrant.share, rootKey: boundGrant.key, tree: resolved.raw }, input.target);
      if (!field || !visitorFileFits(field.file, input.file)) return dead();
      const site = process.env.CONVEX_SITE_URL;
      if (!site) return dead();
      for (const expired of await expiredVisitorUploads(ctx)) await refundUpload(ctx, expired);
      const budgets = await reserveUploadBudgets(ctx, boundGrant, resolved.share, input.file.bytes, now);
      if (!budgets) return limited();
      if (!await consumeNonce()) refuse("This upload could not start.");
      const ticket = await reserveVisitorUpload(ctx, { orgId: boundGrant.orgId, moduleId: boundGrant.moduleId, grantId: boundGrant._id,
        visitorId: boundVisitor._id, sessionHash: boundVisitor.sessionHash, policyHash: boundGrant.policyHash, rootCreatedAt: boundGrant.rootCreatedAt, generation: field.generation,
        target: input.target, collection: field.collection, label, verified: boundVisitor.verified, budgets }, input.file);
      return { ok: true, value: { ...ticket, url: `${site}/modules/visitor-upload` } };
    }, async file(id) {
      if (fn !== "visits:visitFile" || !shareReferences(resolved.manifest, resolved.share, resolved.docs).files.includes(id)) return null;
      return shareFileDownload(ctx, boundGrant.orgId, boundGrant.moduleId, id);
    }, async page(path) {
    if (fn !== "visits:visitPage" && fn !== "visits:visitOpen") return null;
    if (path !== undefined && (path.length > 500 || !/^[A-Za-z0-9_/-]+$/.test(path) || path.split("/").some((s) => !s || s === "." || s === ".."))) return null;
    const { manifest, share, docs } = resolved, refs = shareReferences(manifest, share, docs);
    const members: SharePayload["members"] = {};
    for (const id of refs.members) {
      const uid = ctx.db.normalizeId("users", id), user = uid ? await ctx.db.get(uid) : null;
      if (user && user.isActive && !user.isHidden && await userBelongsToOrg(ctx, user, boundGrant.orgId)) members[id] = Object.fromEntries(share.members.map((f) => [f, user[f] ?? null]));
    }
    const org = await ctx.db.get(boundGrant.orgId);
    const payload = sharePayload(manifest, share, docs, org?.name ?? "Workspace", members, await shareFileInfo(ctx, boundGrant.orgId, boundGrant.moduleId, refs.files), path);
    const recordGeneration = share.record ? resolved.raw[share.collection][0].gens?.[share.record.collection] ?? resolved.raw[share.collection][0].gen ?? 0 : 0;
    if (payload && await counter(ctx, `page:${boundVisitor._id}:${recordGeneration}:${payload.page.path}:${Math.floor(now / 3_600_000)}`, 1, 3_600_000, now)) {
      await recordVisitEvent(ctx, { orgId: boundGrant.orgId, moduleId: boundGrant.moduleId, collection: boundGrant.collection, key: boundGrant.key }, { kind: "visitor", grant: boundGrant.publicId, visitor: boundVisitor._id, verified: boundVisitor.verified }, "visit.page", payload.page.path);
      await recordEngagement(ctx, boundGrant, boundVisitor, resolved, "opened", now);
    }
    return payload;
  } };
  return { ok: true, value: scope };
}
