"use client";

import { useMemo } from "react";
import { useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "../../../convex/_generated/api";
import { indexObjectDef, type ObjectDef } from "../../../convex/lib/objects/registry";
import { relationsOf } from "../../../convex/lib/objects/reportSpec";
import type { ReportSpec } from "../../../convex/lib/objects/validators";
import type { ObjectDescription, TeamMember } from "../records/fields";
import { present, type FieldInfo, type Presented } from "./present";

export type RunResult = FunctionReturnType<typeof api.reports.run>;

const SYSTEM: Record<string, FieldInfo> = {
  recordTitle: { label: "Name", type: "text" },
  createdAt: { label: "Created", type: "datetime" },
  updatedAt: { label: "Last modified", type: "datetime" },
};

/** A field of the object `d` describes, or one of the register's own (name, created, last modified). */
export const info = (d: ObjectDescription | null | undefined, name: string): FieldInfo | undefined =>
  SYSTEM[name] ?? (d?.fields.find((f) => f.apiName === name) as FieldInfo | undefined);

/** The descriptions a report's labels come from: its object's, and each related object a key reads. */
export function useReportDescriptions(spec: Pick<ReportSpec, "object" | "groupBy"> | null) {
  const desc = useQuery(api.objects.describe, spec ? { object: spec.object } : "skip");
  const def = useMemo(() => (desc ? indexObjectDef(desc as unknown as ObjectDef) : null), [desc]);
  const relations = useMemo(() => (def && spec ? relationsOf(spec.object, def) : []), [def, spec]);
  const relObject = (i: number) => relations.find((r) => r.via === spec?.groupBy[i]?.via)?.object;
  const rel0 = useQuery(api.objects.describe, relObject(0) ? { object: relObject(0)! } : "skip");
  const rel1 = useQuery(api.objects.describe, relObject(1) ? { object: relObject(1)! } : "skip");
  return { desc, def, relations, keyDescs: [spec?.groupBy[0]?.via ? rel0 : desc, spec?.groupBy[1]?.via ? rel1 : desc] as const };
}

/** A run result as people read it, labelled from the result's own spec. */
export function usePresented(result: RunResult | null): Presented | null {
  const team = useQuery(api.users.list) as TeamMember[] | undefined;
  const { desc, relations, keyDescs } = useReportDescriptions(result?.spec ?? null);
  if (!result) return null;
  const s = result.spec;
  const keyFields = s.groupBy.map((g, i) => info(keyDescs[i], g.field));
  return present(s, result, keyFields, s.measures.map((m) => (m.field ? info(desc, m.field) : undefined)), team ?? [], s.groupBy.map((g) => relations.find((r) => r.via === g.via)?.label));
}
