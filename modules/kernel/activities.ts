import type { ActivityDecl } from "./manifest.ts";
import type { ReadDoc } from "./calls.ts";
import type { ModuleActivity } from "../../convex/lib/activities.ts";

export type ModuleActivitySearchHit = {
  id: string; title: string; activityKind: string; moduleTitle: string; source: ModuleActivity["source"];
};
export type ModuleActivitySearchResult =
  | { kind: "ready"; hits: ModuleActivitySearchHit[] }
  | { kind: "unavailable"; message: string };

type DeclaredActivityRef = { object: "account" | "contact"; id: string } | { object: "deal"; id: string };
export type ModuleActivityData = {
  activity: {
    id: string; kind: "module"; activityKind: string; subject: string; at: number; date?: string;
    ownerId: string | null; status: string | null; dueDate: string | null;
  };
  createdAt: number; refs: DeclaredActivityRef[];
};

const text = (value: unknown) => typeof value === "string" && value !== "" ? value : null;
const ids = (value: unknown): string[] => [...new Set((Array.isArray(value) ? value : [value]).flatMap((v) => text(v) ?? []))];

/** Ref ids are still in the module schema's namespace. */
export function moduleActivityDataOf(moduleId: string, collection: string, decl: ActivityDecl, doc: ReadDoc): ModuleActivityData {
  const value = (field: string | undefined) => field === undefined ? null : doc.data[field];
  const when = value(decl.at);
  const parsed = typeof when === "number" ? when : typeof when === "string" ? Date.parse(`${when}T00:00:00Z`) : NaN;
  const refs: DeclaredActivityRef[] = [];
  for (const [target, object] of [["companies", "account"], ["people", "contact"], ["deals", "deal"]] as const) {
    for (const id of ids(value(decl.targets[target]))) refs.push({ object, id });
  }
  return {
    activity: {
      id: `module:${[moduleId, collection, doc.key].map(encodeURIComponent).join("/")}`,
      kind: "module", activityKind: decl.kind, subject: text(value(decl.subject)) ?? doc.key,
      at: Number.isFinite(parsed) ? parsed : doc.createdAt,
      ...(typeof when === "string" && Number.isFinite(parsed) ? { date: when } : {}),
      ownerId: text(value(decl.owner)), status: text(value(decl.status)), dueDate: text(value(decl.dueDate)),
    },
    createdAt: doc.createdAt, refs,
  };
}

export function moduleActivityOf(moduleId: string, slug: string, collection: string, decl: ActivityDecl, doc: ReadDoc): {
  activity: ModuleActivity; createdAt: number; refs: DeclaredActivityRef[];
} {
  if (doc.key === "." || doc.key === "..") throw new Error("An activity detail link cannot use a dot segment as its key.");
  const canonical = moduleActivityDataOf(moduleId, collection, decl, doc);
  const href = `/dashboard/m/${encodeURIComponent(slug)}/${decl.path.replace(":key", encodeURIComponent(doc.key))}`;
  return { ...canonical, activity: { ...canonical.activity, source: { moduleId, collection, key: doc.key, href } } };
}
