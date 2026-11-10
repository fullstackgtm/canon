"use client";

import { useMemo } from "react";
import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { STANDARD_OBJECTS } from "../../../convex/lib/objects/registry";

export type ObjectNames = { label: string; pluralLabel: string };

/**
 * Each object's names as the workspace calls it (an admin renames a standard object on the Data model page). Until
 * the workspace's names load, a standard object reads as Canon names it.
 */
export function useObjectLabels(): (object: string) => ObjectNames | undefined {
  const objects = useQuery(api.dataModel.objects);
  return useMemo(() => {
    const named = new Map<string, ObjectNames>((objects ?? []).map((o) => [o.apiName, { label: o.label, pluralLabel: o.pluralLabel }]));
    return (object: string) => named.get(object) ?? (Object.hasOwn(STANDARD_OBJECTS, object) ? STANDARD_OBJECTS[object as keyof typeof STANDARD_OBJECTS] : undefined);
  }, [objects]);
}
