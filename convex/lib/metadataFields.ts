import type { QueryCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { orgObjectDefs } from "../ledgerFeed";
import { isRestricted, type Access } from "./access";
import { withheldFields } from "./withheldFields";

export async function metadataFields(ctx: QueryCtx, orgId: Id<"organizations">, access: Access): Promise<Map<string, Set<string>>> {
  return isRestricted(access) ? withheldFields([access], await orgObjectDefs(ctx, orgId)) : new Map();
}
