/**
 * The record API's relationship writes (docs/record-api.md): merges and
 * duplicates, links between people and companies, deal roles and activities.
 * Each calls the Convex function the dashboard calls, as the token's user, so
 * role checks are the dashboard's (merge, undo and dismiss: admins and
 * managers). Bodies are parsed with their schemas in _contract.ts, which the
 * OpenAPI document describes.
 */
import { api } from "../../../../convex/_generated/api.js";
import { V1Error, type V1Client, type V1Result } from "./_lib.ts";
import { getRecord } from "./_records.ts";
import { ActivityBody, AssociationBody, DealRoleBody, DismissBody, MergeBody, MergePreviewBody, parseBody, readQuery, OPERATIONS, TIMELINE_OBJECTS } from "./_contract.ts";

const MERGE_OBJECTS = ["account", "contact"];
const mergeObject = (object: string) => {
  if (!MERGE_OBJECTS.includes(object)) throw new V1Error("unknown_object", "Only account and contact records can be merged");
  return object as "account" | "contact";
};
const ok = (data: unknown, status = 200): V1Result => ({ status, body: { data } });

// ---- duplicates and merges ----

export async function listDuplicates(client: V1Client, object: string): Promise<V1Result> {
  return ok(await client.action(api.duplicates.list, { object: mergeObject(object) }));
}

export async function dismissDuplicates(client: V1Client, object: string, raw: unknown): Promise<V1Result> {
  const merged = mergeObject(object);
  await client.action(api.duplicates.dismiss, { object: merged, ids: parseBody(DismissBody, raw).ids });
  return ok(null);
}

export async function previewMerge(client: V1Client, object: string, raw: unknown): Promise<V1Result> {
  const merged = mergeObject(object);
  return ok(await client.action(api.recordMerges.preview, { object: merged, ids: parseBody(MergePreviewBody, raw).ids }));
}

export async function mergeRecords(client: V1Client, object: string, raw: unknown): Promise<V1Result> {
  const merged = mergeObject(object);
  const b = parseBody(MergeBody, raw);
  return ok(await client.action(api.recordMerges.merge, { object: merged, survivorId: b.survivorId, loserIds: b.loserIds, picks: b.picks ?? {} }));
}

export async function undoMerge(client: V1Client, mergeId: string): Promise<V1Result> {
  return ok(await client.action(api.recordMerges.undo, { mergeId }));
}

// ---- associations ----

/** `{ op: "link" | "unlink" | "make_primary", contactId, accountId, primary? }` or `{ op: "set_parent", accountId, parentId | null }`. */
export async function changeAssociation(client: V1Client, raw: unknown): Promise<V1Result> {
  const b = parseBody(AssociationBody, raw);
  switch (b.op) {
    case "link": return ok(await client.action(api.associations.link, { contactId: b.contactId, accountId: b.accountId, ...(b.primary === true ? { primary: true } : {}) }));
    case "unlink": return ok(await client.action(api.associations.unlink, { contactId: b.contactId, accountId: b.accountId }));
    case "make_primary": return ok(await client.action(api.associations.makePrimary, { contactId: b.contactId, accountId: b.accountId }));
    case "set_parent": return ok(await client.action(api.associations.setParent, { accountId: b.accountId, parentId: b.parentId ?? null }));
  }
}

export async function relatedRecords(client: V1Client, params: URLSearchParams): Promise<V1Result> {
  readQuery(OPERATIONS.find((o) => o.id === "related")!.query!, params, false);
  return ok(await client.action(api.associations.related, { object: params.get("object") as "account" | "contact", id: params.get("id")! }));
}

// ---- deal roles ----

export async function dealRoles(client: V1Client, streamId: string): Promise<V1Result> {
  const people = await client.action(api.dealCommittee.forDeal, { streamId });
  if (!people) throw new V1Error("not_found", "No such deal");
  return ok(people);
}

export async function setDealRole(client: V1Client, streamId: string, raw: unknown): Promise<V1Result> {
  const b = parseBody(DealRoleBody, raw);
  return ok(await client.action(api.dealCommittee.setRole, { streamId, contactId: b.contactId, role: b.role, ...(b.reason !== undefined ? { reason: b.reason } : {}) }));
}

export async function removeFromDeal(client: V1Client, streamId: string, contactId: string): Promise<V1Result> {
  return ok(await client.action(api.dealCommittee.removeFromDeal, { streamId, contactId }));
}

// ---- activities ----

/** `{ object: "note" | "task" | "call" | "meeting", values, targets: [{ object, id }] }`: one activity, an edge to each target. */
export async function logActivity(client: V1Client, raw: unknown, idempotencyKey?: string): Promise<V1Result> {
  const b = parseBody(ActivityBody, raw);
  return ok(await client.action(api.activityTargets.logScoped, { object: b.object, values: (b.values ?? {}) as never, targets: b.targets ?? [], ...(idempotencyKey ? { idempotencyKey } : {}) }), 201);
}

export async function recordActivities(client: V1Client, object: string, id: string): Promise<V1Result> {
  if (!(TIMELINE_OBJECTS as readonly string[]).includes(object)) throw new V1Error("unknown_object", "Timelines exist for account, contact and deal records");
  // forRecord answers an empty timeline for an id that names nothing; say the record does not exist instead.
  await getRecord(client, object, id);
  return ok(await client.action(api.activityTargets.forRecord, { object: object as "account", id }));
}
