/**
 * The record API's relationship writes (docs/record-api.md): merges and
 * duplicates, links between people and companies, deal roles and activities.
 * Each calls the Convex function the dashboard calls, as the token's user, so
 * role checks are the dashboard's (merge, undo and dismiss: admins and
 * managers). Argument shapes are checked by the Convex validators.
 */
import { api } from "../../../../convex/_generated/api.js";
import { V1Error, type V1Client, type V1Result } from "./_lib.ts";
import { getRecord } from "./_records.ts";

type Body = Record<string, unknown>;

const isObject = (x: unknown): x is Body => typeof x === "object" && x !== null && !Array.isArray(x);
const body = (x: unknown): Body => {
  if (!isObject(x)) throw new V1Error("invalid_request", "The body must be a JSON object");
  return x;
};
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
  await client.action(api.duplicates.dismiss, { object: mergeObject(object), ids: body(raw).ids as string[] });
  return ok(null);
}

export async function previewMerge(client: V1Client, object: string, raw: unknown): Promise<V1Result> {
  return ok(await client.action(api.recordMerges.preview, { object: mergeObject(object), ids: body(raw).ids as string[] }));
}

export async function mergeRecords(client: V1Client, object: string, raw: unknown): Promise<V1Result> {
  const b = body(raw);
  return ok(await client.action(api.recordMerges.merge, {
    object: mergeObject(object), survivorId: b.survivorId as string, loserIds: b.loserIds as string[], picks: (b.picks ?? {}) as Record<string, string>,
  }));
}

export async function undoMerge(client: V1Client, mergeId: string): Promise<V1Result> {
  return ok(await client.action(api.recordMerges.undo, { mergeId }));
}

// ---- associations ----

const ASSOCIATION_OPS = ["link", "unlink", "make_primary", "set_parent"] as const;

/** `{ op: "link" | "unlink" | "make_primary", contactId, accountId, primary? }` or `{ op: "set_parent", accountId, parentId | null }`. */
export async function changeAssociation(client: V1Client, raw: unknown): Promise<V1Result> {
  const b = body(raw);
  const contactId = b.contactId as string;
  const accountId = b.accountId as string;
  switch (b.op) {
    case "link": return ok(await client.action(api.associations.link, { contactId, accountId, ...(b.primary === true ? { primary: true } : {}) }));
    case "unlink": return ok(await client.action(api.associations.unlink, { contactId, accountId }));
    case "make_primary": return ok(await client.action(api.associations.makePrimary, { contactId, accountId }));
    case "set_parent": return ok(await client.action(api.associations.setParent, { accountId, parentId: (b.parentId ?? null) as string | null }));
    default: throw new V1Error("invalid_request", `op must be one of ${ASSOCIATION_OPS.join(", ")}`);
  }
}

export async function relatedRecords(client: V1Client, params: URLSearchParams): Promise<V1Result> {
  const object = params.get("object");
  const id = params.get("id");
  if ((object !== "account" && object !== "contact") || !id) throw new V1Error("invalid_request", "Pass object=account|contact and id");
  return ok(await client.action(api.associations.related, { object, id }));
}

// ---- deal roles ----

export async function dealRoles(client: V1Client, streamId: string): Promise<V1Result> {
  const people = await client.action(api.dealCommittee.forDeal, { streamId });
  if (!people) throw new V1Error("not_found", "No such deal");
  return ok(people);
}

export async function setDealRole(client: V1Client, streamId: string, raw: unknown): Promise<V1Result> {
  const b = body(raw);
  return ok(await client.action(api.dealCommittee.setRole, {
    streamId, contactId: b.contactId as string, role: b.role as never, ...(typeof b.reason === "string" ? { reason: b.reason } : {}),
  }));
}

export async function removeFromDeal(client: V1Client, streamId: string, contactId: string): Promise<V1Result> {
  return ok(await client.action(api.dealCommittee.removeFromDeal, { streamId, contactId }));
}

// ---- activities ----

/** `{ object: "note" | "task" | "call" | "meeting", values, targets: [{ object, id }] }`: one activity, an edge to each target. */
export async function logActivity(client: V1Client, raw: unknown): Promise<V1Result> {
  const b = body(raw);
  return ok(await client.action(api.activityTargets.logScoped, {
    object: b.object as never, values: (b.values ?? {}) as never, targets: (b.targets ?? []) as never,
  }), 201);
}

export async function recordActivities(client: V1Client, object: string, id: string): Promise<V1Result> {
  if (!["account", "contact", "deal"].includes(object)) throw new V1Error("unknown_object", "Timelines exist for account, contact and deal records");
  // forRecord answers an empty timeline for an id that names nothing; say the record does not exist instead.
  await getRecord(client, object, id);
  return ok(await client.action(api.activityTargets.forRecord, { object: object as "account", id }));
}
