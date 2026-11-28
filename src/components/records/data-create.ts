import type { ConvexReactClient } from "convex/react";
import { api } from "../../../convex/_generated/api";
import type { ObjectDescription, CellValue } from "./fields";
import { saveOf, saveProblem } from "./board-move";

/** Dispatch kernel.createRecord through the same creates as the record API and New deal. */
export async function createDataRecord(client: Pick<ConvexReactClient, "action">, desc: ObjectDescription, values: Record<string, CellValue>, idempotencyKey: string) {
  if (!desc.canCreate) throw new Error("You cannot create this object");
  for (const name of Object.keys(values)) {
    const field = desc.fields.find((f) => f.apiName === name);
    if (!field || field.hidden || desc.readOnlyFields.includes(name)) throw new Error(`You cannot write ${name}`);
  }
  if (desc.apiName === "deal") {
    const allowed = ["name", "amount", "currency", "closeDate", "stage", "pipelineId", "dealType", "revenueType", "ownerId", "companyId"];
    if (Object.keys(values).some((k) => !allowed.includes(k) && !k.startsWith("custom."))) throw new Error("That field is not available when creating a deal");
    const { ownerId, ...input } = Object.fromEntries(Object.entries(values).filter(([k]) => !k.startsWith("custom.")));
    const custom = Object.fromEntries(Object.entries(values).filter(([k]) => k.startsWith("custom.")));
    const out = await client.action(api.deals.createScoped, { ...input, ...(ownerId ? { primaryRepId: ownerId } : {}), custom, idempotencyKey } as never);
    const problem = saveProblem(out.result);
    if (problem) throw new Error(problem);
    return saveOf(out.result);
  }
  if (desc.register) {
    const account = desc.apiName === "account";
    await client.action(api.records.upsert, { object: desc.apiName, [account ? "accounts" : "contacts"]: [values], idempotencyKey } as never);
    return [];
  }
  const out = await client.action(api.objects.writeScoped, { object: desc.apiName, values, idempotencyKey } as never);
  const problem = saveProblem(out);
  if (problem) throw new Error(problem);
  return saveOf(out);
}

export function dataCreateFields(desc: ObjectDescription) {
  return desc.fields.filter((f) => !f.hidden && !f.system && !desc.readOnlyFields.includes(f.apiName) &&
    (desc.apiName !== "deal" ? f.required || f.fieldId === desc.titleFieldId
      : ["name", "closeDate", "stage", "amount"].includes(f.apiName) || f.required && f.apiName.startsWith("custom.")));
}
