/**
 * What a person's or an API caller's write may name (docs/record-api.md): a user field takes an active member of the
 * workspace, a lookup a record of its object in the workspace that the caller sees. A lookup the caller does not see
 * is refused exactly as one that does not exist, so a write cannot probe for records.
 *
 * Every caller write applies `referenceErrors` (tests/writeReferences.test.ts lists them). CRM syncs, imports and
 * Canon's own writers do not: they name CRM owners and records that have not arrived yet, and their values come from
 * a source, not a caller.
 */
import type { Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { entitySight, recordSight, sightAdmits } from "../permissions";
import type { Access } from "./access";
import { ID } from "./canon/identity";
import { activeRoleIn } from "./membership";
import type { CoerceError, ResolvedObjectDef } from "./objects/registry";
import type { RecordClient } from "./recordClient";
import { visibleIds } from "./scopedRecordClient";

/**
 * Who is writing. `admitted`: the company and person ids an action confirmed through the caller's scoped client
 * (admitRegisterIds); only the record service knows a company nobody has worked yet.
 */
export type ReferenceScope = { orgId: Id<"organizations">; access: Access; admitted: ReadonlySet<string> };

/** The company and person ids among a write's values that the caller sees, read through their scoped client. */
export async function admitRegisterIds(client: RecordClient, ws: string, values: Record<string, unknown>): Promise<string[]> {
  const ids = Object.values(values).filter((x): x is string => typeof x === "string").map((x) => x.trim());
  return [
    ...await visibleIds(client, ws, "account", ids.filter((x) => x.startsWith("acc_"))),
    ...await visibleIds(client, ws, "contact", ids.filter((x) => x.startsWith("con_"))),
  ];
}

/** The user and lookup values of a write (keyed by apiName) that name no member or no record the caller sees. */
export async function referenceErrors(ctx: QueryCtx, scope: ReferenceScope, def: ResolvedObjectDef, values: Record<string, unknown>): Promise<CoerceError[]> {
  const errors: CoerceError[] = [];
  for (const [apiName, raw] of Object.entries(values)) {
    const field = def.byApiName.get(apiName);
    const id = typeof raw === "string" ? raw.trim() : "";
    // An empty value clears the field, and a value of the wrong type is coerce's to refuse.
    if (!field || !id) continue;
    if (field.type === "user" && !(await isActiveMember(ctx, scope.orgId, id))) {
      errors.push({ field: apiName, message: `${field.label} must be an active member of this workspace` });
    } else if (field.type === "lookup" && !(await seesRecord(ctx, scope, field.lookupTo, id))) {
      errors.push({ field: apiName, message: `${field.label} must name a record you can see` });
    }
  }
  return errors;
}

async function isActiveMember(ctx: QueryCtx, orgId: Id<"organizations">, id: string): Promise<boolean> {
  const userId = ctx.db.normalizeId("users", id);
  return userId !== null && (await activeRoleIn(ctx, { _id: userId }, orgId)) !== null;
}

async function seesRecord(ctx: QueryCtx, scope: ReferenceScope, object: string, id: string): Promise<boolean> {
  const accesses = [scope.access];
  if (object === "account" || object === "contact") {
    // Admitted ids are companies and people alike: the prefix says which.
    if (!id.startsWith(object === "account" ? "acc_" : "con_")) return false;
    if (scope.admitted.has(id)) return true;
    // Without an action's word, a company or person Convex has a stream for, and the caller's role sees all of.
    const ext = await ctx.db.query("canonExternalIds")
      .withIndex("by_orgId_provider_externalId", (q) => q.eq("orgId", scope.orgId).eq("provider", object === "account" ? ID.recordAccount : ID.recordContact).eq("externalId", id))
      .first();
    return ext !== null && sightAdmits(recordSight(accesses, object, id), scope.admitted);
  }
  const streamId = ctx.db.normalizeId("canonEntities", id);
  const entity = streamId ? await ctx.db.get(streamId) : null;
  if (!entity || entity.orgId !== scope.orgId || (entity.entityType === "opportunity" ? "deal" : entity.entityType) !== object) return false;
  return sightAdmits(await entitySight(ctx, accesses, entity), scope.admitted);
}
