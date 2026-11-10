import type { ListRow } from "../objects/listSpec.ts";
import type { RecordClient } from "../recordClient.ts";
import { IN_VALUES_MAX, LIST_LIMIT_MAX } from "../objects/listSpec.ts";
import type { PeopleQuery } from "./canonReads.ts";

import { variableName, type OutboundContact } from "../outbound/audience.ts";

export type PeopleExportSource = { people: PeopleQuery; filename: string; recorded: boolean; epoch: number; orgId: string; userId: string | null };

const text = (value: unknown): string | null => typeof value === "string" && value !== "" ? value : null;
const scalar = (value: unknown): value is string | number | boolean => typeof value === "string" || typeof value === "number" || typeof value === "boolean";

export function customOf(values: Record<string, unknown>): OutboundContact["custom"] {
  return Object.fromEntries(Object.entries(values).sort(([a], [b]) => a.localeCompare(b)).flatMap(([key, value]) => {
    if (!key.startsWith("custom.")) return [];
    const normalized = Array.isArray(value) ? value.filter((v) => scalar(v) && v !== "").join("; ") : scalar(value) ? value : null;
    return normalized === null || normalized === "" ? [] : [[variableName(key), normalized]];
  }));
}

export const customVariablesOf = (rows: readonly ListRow[]): string[] => [...new Set(rows.flatMap((row) => Object.keys(customOf(row.values))))].sort();

export async function peopleContacts(client: RecordClient, orgId: string, rows: readonly ListRow[]): Promise<OutboundContact[]> {
  const account = (row: ListRow & { accountId?: string }) => text(row.accountId);
  const ids = [...new Set(rows.flatMap((row) => account(row) ?? []))];
  const names: Record<string, string> = {};
  const size = Math.min(IN_VALUES_MAX, LIST_LIMIT_MAX);
  for (let i = 0; i < ids.length; i += size) {
    const page = await client.listRegister(orgId, "account", { filter: [{ field: "id", op: "in", value: ids.slice(i, i + size) }], limit: size });
    for (const row of page.rows) if (text(row.values.name)) names[row.id] = String(row.values.name);
  }
  const list = (value: unknown): string[] => Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && v !== "") : [];
  return rows.map((row) => ({
    id: row.id, email: text(row.values.email), fullName: text(row.values.fullName) ?? "",
    title: text(row.values.title), company: names[account(row) ?? ""] ?? null,
    phone: text(row.values.phone), linkedinUrl: text(row.values.linkedinUrl),
    otherEmails: list(row.values.additionalEmails), otherPhones: list(row.values.additionalPhones), custom: customOf(row.values),
  }));
}
