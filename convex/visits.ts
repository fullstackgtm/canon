import { v } from "convex/values";
import { mutation, internalMutation } from "./_generated/server";
import { visitorScope, visitorUploadTicket, finishVisitorUpload, cancelVisitorUpload, expiryNotices } from "./lib/modules/visitors";

const uploadTarget = v.union(
  v.object({ kind: v.literal("op"), op: v.string(), key: v.optional(v.string()), expect: v.optional(v.number()), field: v.string() }),
  v.object({ kind: v.literal("transition"), machine: v.string(), transition: v.string(), key: v.string(), expect: v.number(), field: v.string() }),
);

export const visitOpen = mutation({
  args: { envelope: v.string(), tokenHash: v.string(), newSessionHash: v.string(), sessions: v.array(v.object({ publicId: v.string(), sessionHash: v.string() })), name: v.optional(v.string()), email: v.optional(v.string()) },
  handler: async (ctx, { envelope, ...args }) => {
    const result = await visitorScope(ctx, envelope, "visits:visitOpen", args);
    if (!result.ok) return result;
    const { grant, visitor } = result.value;
    return { ok: true as const, value: { publicId: grant.publicId, expiresAt: grant.expiresAt, reused: visitor.sessionHash !== args.newSessionHash } };
  },
});

export const visitPage = mutation({
  args: { envelope: v.string(), publicId: v.string(), sessionHash: v.string(), path: v.optional(v.string()) },
  handler: async (ctx, { envelope, ...args }) => {
    const result = await visitorScope(ctx, envelope, "visits:visitPage", args);
    if (!result.ok) return result;
    const payload = await result.value.page(args.path);
    return payload ? { ok: true as const, value: payload } : { ok: false as const, status: 403 as const };
  },
});

export const visitOp = mutation({
  args: { envelope: v.string(), publicId: v.string(), sessionHash: v.string(), op: v.string(), key: v.optional(v.string()), expect: v.optional(v.number()), data: v.optional(v.record(v.string(), v.any())), unset: v.optional(v.array(v.string())) },
  handler: async (ctx, { envelope, ...args }) => {
    const result = await visitorScope(ctx, envelope, "visits:visitOp", args);
    if (!result.ok) return result;
    return result.value.op({ kind: "op", op: args.op, ...(args.key === undefined ? {} : { key: args.key }), ...(args.expect === undefined ? {} : { expect: args.expect }), ...(args.data === undefined ? {} : { data: args.data }), ...(args.unset === undefined ? {} : { unset: args.unset }) });
  },
});

export const visitTransition = mutation({
  args: { envelope: v.string(), publicId: v.string(), sessionHash: v.string(), machine: v.string(), transition: v.string(), key: v.string(), expect: v.number(), args: v.optional(v.record(v.string(), v.any())) },
  handler: async (ctx, { envelope, ...args }) => {
    const result = await visitorScope(ctx, envelope, "visits:visitTransition", args);
    if (!result.ok) return result;
    return result.value.transition({ kind: "transition", machine: args.machine, transition: args.transition, key: args.key, expect: args.expect, ...(args.args === undefined ? {} : { args: args.args }) });
  },
});

export const visitUpload = mutation({
  args: { envelope: v.string(), publicId: v.string(), sessionHash: v.string(), target: uploadTarget,
    file: v.object({ name: v.string(), type: v.string(), bytes: v.number(), digest: v.string() }) },
  handler: async (ctx, { envelope, ...args }) => {
    const result = await visitorScope(ctx, envelope, "visits:visitUpload", args);
    if (!result.ok) return result;
    return result.value.upload(args);
  },
});

export const visitFile = mutation({
  args: { envelope: v.string(), publicId: v.string(), sessionHash: v.string(), file: v.string() },
  handler: async (ctx, { envelope, ...args }) => {
    const result = await visitorScope(ctx, envelope, "visits:visitFile", args);
    if (!result.ok) return result;
    const file = await result.value.file(args.file);
    return file ? { ok: true as const, value: file } : { ok: false as const, status: 403 as const };
  },
});

export const visitRequestCode = mutation({
  args: { envelope: v.string(), publicId: v.string(), sessionHash: v.string(), email: v.string() },
  handler: async (ctx, { envelope, ...args }) => {
    const result = await visitorScope(ctx, envelope, "visits:visitRequestCode", args);
    if (!result.ok) return result;
    return result.value.requestCode(args.email);
  },
});

export const visitVerifyCode = mutation({
  args: { envelope: v.string(), publicId: v.string(), sessionHash: v.string(), code: v.string() },
  handler: async (ctx, { envelope, ...args }) => {
    const result = await visitorScope(ctx, envelope, "visits:visitVerifyCode", args);
    if (!result.ok) return result;
    return result.value.verifyCode(args.code);
  },
});

export const uploadTicket = internalMutation({
  args: { ticket: v.string(), secret: v.string() },
  handler: async (ctx, args) => {
    const row = await visitorUploadTicket(ctx, args.ticket, args.secret);
    return row ? { name: row.name, type: row.type, bytes: row.bytes, digest: row.visitorUpload!.digest, state: row.visitorUpload!.state } : null;
  },
});

export const finishUpload = internalMutation({
  args: { ticket: v.string(), secret: v.string(), storageId: v.id("_storage") },
  handler: async (ctx, args) => finishVisitorUpload(ctx, args.ticket, args.secret, args.storageId),
});

export const releaseUpload = internalMutation({
  args: { ticket: v.string(), secret: v.string(), storageId: v.optional(v.id("_storage")) },
  handler: async (ctx, args) => { await cancelVisitorUpload(ctx, args.ticket, args.secret, args.storageId); return null; },
});

export const notifyExpiring = internalMutation({
  args: {},
  handler: async (ctx) => expiryNotices(ctx),
});
