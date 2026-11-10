import { v, ConvexError } from "convex/values";
import { internalMutation } from "./_generated/server";

export const operate = internalMutation({
  args: { key: v.string(), holder: v.string(), epoch: v.number(), operation: v.union(v.literal("acquire"), v.literal("mint"), v.literal("commit"), v.literal("heartbeat")), seq: v.optional(v.number()), writes: v.optional(v.string()), minimum: v.optional(v.number()) },
  handler: async (ctx, args) => {
    if (process.env.FSGTM_ENABLE_DEMO_DATA !== "true") throw new ConvexError("Local prototype disabled");
    if (!/^pi-probe-[a-zA-Z0-9-]{1,80}$/.test(args.key)) throw new ConvexError("Invalid prototype key");
    const now = Date.now();
    let row = await ctx.db.query("piPrototypeLeases").withIndex("by_key", (q) => q.eq("key", args.key)).unique();
    if (args.operation === "acquire") {
      if (row && row.expiresAt > now && row.holder !== args.holder) throw new ConvexError("Lease is occupied");
      const epoch = (row?.epoch ?? 0) + 1;
      if (row) await ctx.db.patch(row._id, { holder: args.holder, epoch, expiresAt: now + 3000 });
      else {
        const id = await ctx.db.insert("piPrototypeLeases", { key: args.key, holder: args.holder, epoch, expiresAt: now + 3000, seq: 0, nextId: 2 });
        row = await ctx.db.get(id);
      }
      const commits = await ctx.db.query("piPrototypeCommits").withIndex("by_key_and_seq", (q) => q.eq("key", args.key)).take(129);
      if (commits.length > 128) throw new ConvexError("Prototype journal limit reached");
      return { epoch, seq: row!.seq, commits: commits.map((c) => ({ seq: c.seq, writes: c.writes })) };
    }
    if (!row || row.holder !== args.holder || row.epoch !== args.epoch || row.expiresAt <= now) throw new ConvexError("Fenced stale owner");
    await ctx.db.patch(row._id, { expiresAt: now + 3000 });
    if (args.operation === "heartbeat") return { ok: true };
    if (args.operation === "mint") {
      const id = Math.max(row.nextId, args.minimum ?? 2);
      if (!Number.isSafeInteger(id) || id < 2) throw new ConvexError("Invalid candidate ID");
      await ctx.db.patch(row._id, { nextId: id + 1 });
      return { id };
    }
    if (args.seq === row.seq && args.writes) {
      const prior = await ctx.db.query("piPrototypeCommits").withIndex("by_key_and_seq", (q) => q.eq("key", args.key).eq("seq", args.seq!)).unique();
      if (prior?.writes === args.writes) return { seq: args.seq };
    }
    if (args.seq !== row.seq + 1 || row.seq >= 128 || !args.writes || args.writes.length > 256_000) throw new ConvexError("Invalid commit");
    await ctx.db.insert("piPrototypeCommits", { key: args.key, seq: args.seq, writes: args.writes });
    await ctx.db.patch(row._id, { seq: args.seq });
    return { seq: args.seq };
  },
});
