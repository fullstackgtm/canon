import { ConvexError, v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { moduleScope, systemScope } from "./lib/modules/scope";
import { workspaceMembers } from "./permissions";
import { peopleExportProblems } from "../modules/kernel/manifest.ts";
import { AUDIENCE_MAX } from "./lib/outbound/audience";

export const recordRun = internalMutation({
  args: { module: v.string(), export: v.string(), args: v.record(v.string(), v.any()), epoch: v.number(), orgId: v.id("organizations"), actor: v.id("users"), count: v.number() },
  handler: async (ctx, a): Promise<void> => {
    const caller = await moduleScope(ctx, a.module);
    if (!caller || caller.preview || caller.orgId !== a.orgId || caller.epoch !== a.epoch || caller.userId !== a.actor) throw new ConvexError("The export's caller or module changed. Try again.");
    const x = caller.manifest.exports?.[a.export];
    if (!x || !("people" in x) || !x.record || peopleExportProblems(caller.manifest, x).length) throw new ConvexError("This recorded people export is no longer available.");
    const key = a.args[x.people.key.arg];
    if (typeof key !== "string" || !key || Object.keys(a.args).some((k) => k !== x.people.key.arg)) throw new ConvexError("Invalid people export arguments.");
    await caller.peopleQuery(x.people.provide, key);
    if (!(await workspaceMembers(ctx, caller.orgId)).some((m) => m.id === caller.userId)) throw new ConvexError("The export's actor is no longer in this workspace.");
    if (!Number.isInteger(a.count) || a.count < 0 || a.count > AUDIENCE_MAX) throw new ConvexError("Invalid people export count.");
    const system = await systemScope(ctx, caller.orgId, caller.moduleId);
    if (!system || system.epoch !== a.epoch) throw new ConvexError("The module changed during export. Try again.");
    const op = caller.manifest.ops[x.record.op];
    const by = caller.manifest.collections[op.collection].schema.value.by ? { by: caller.userId } : {};
    const at = Date.now();
    await system.op(x.record.op, { parentKey: key, data: { target: "csv", at, sent: 0, exported: a.count, skipped: 0, ...by } });
    if (a.count > 0 && x.record.parent) await system.op(x.record.parent.op, { key, data: { [x.record.parent.field]: at } });
  },
});
