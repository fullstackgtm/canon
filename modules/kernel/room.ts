import type { ModuleManifest, ShareDecl } from "./manifest.ts";

export type RoomSource = { deal: string | null; company: string | null };
export type RoomAttribution = {
  accountId: string; domain: string;
  source: RoomSource;
  deal?: { id: string; streamId: string; companyId: string };
  contact?: { id: string; email: string };
};

export function roomSource(manifest: ModuleManifest, share: ShareDecl, data: Record<string, unknown>): RoomSource {
  const fields = Object.entries(manifest.collections[share.collection].schema.value);
  const direct = (to: "deals" | "companies") => fields.filter(([, s]) => s.fieldType.type === "ref" && s.fieldType.to === to);
  const deals = direct("deals"), companies = direct("companies");
  if (deals.length > 1 || companies.length > 1) throw new Error("Room signals require at most one direct deal and company ref.");
  const value = (entries: typeof fields) => entries.length && typeof data[entries[0][0]] === "string" && data[entries[0][0]] ? String(data[entries[0][0]]) : null;
  return { deal: value(deals), company: value(companies) };
}

export const roomRecordCollections = (manifest: ModuleManifest): ReadonlySet<string> =>
  new Set(Object.values(manifest.shares ?? {}).flatMap((s) => s.record ? [s.record.collection] : []));

export const roomRecordFields = {
  visitor: { type: "string", optional: false }, name: { type: "string", optional: true }, email: { type: "string", optional: true },
  verified: { type: "boolean", optional: false }, day: { type: "string", optional: false },
  views: { type: "number", optional: false }, actions: { type: "number", optional: false }, lastAt: { type: "number", optional: false },
} as const;
