import { ConvexError } from "convex/values";
import type { Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import type { ModuleManifest } from "../../../modules/kernel/manifest.ts";
import type { ModuleScope } from "./scope.ts";

export { importSetKey } from "./importKeys.ts";
import { eventDefinitionsImport } from "../agents/importDefinitions";

export type ImportDoc = { collection: string; key: string; parentKey?: string; createdAt?: number; data: Record<string, unknown> };
type ImportIdentity = {
  module: string;
  label: string;
};
export type ModuleImport = ImportIdentity & ({
  adopt(ctx: MutationCtx, orgId: Id<"organizations">, cursor: string | null): Promise<{ cursor: string | null; error?: string }>;
} | {
  batch(ctx: QueryCtx, orgId: Id<"organizations">, cursor: string | null, scope: Pick<ModuleScope, "view">): Promise<{ docs: ImportDoc[]; cursor: string | null }>;
});

import { audiencesImport, AUDIENCES_IMPORT } from "./audienceImport.ts";

import { reportsImport } from "./reportsImport.ts";

export const MODULE_IMPORTS: Record<string, ModuleImport> = {
  [AUDIENCES_IMPORT]: audiencesImport,
  "reports.legacy": reportsImport,
  "agents.eventDefinitions": eventDefinitionsImport,
};

export function importsOf(m: ModuleManifest): Array<{ name: string; label: string }> {
  return (m.imports ?? []).map((name) => {
    const entry = Object.hasOwn(MODULE_IMPORTS, name) ? MODULE_IMPORTS[name] : null;
    if (!entry || entry.module !== m.id) throw new ConvexError(`${m.id} cannot take the Canon import ${name}.`);
    return { name, label: entry.label };
  });
}
