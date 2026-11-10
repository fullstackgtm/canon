/**
 * Who can see and change what (CP14). One model for people, their API and
 * agent tokens and the agents they own: a token or agent resolves to its
 * user, so it carries that user's role and never sees more than they do.
 *
 * - A role (admin, manager, rep, other) has one permission per object:
 *   which records it sees (all, its teams' or only its own, by the record's
 *   `ownerId`), whether it reads, creates, edits and deletes them, and which
 *   fields are hidden or read-only.
 * - Admins always have full access. A role with no stored policy, or an object
 *   with no rule, keeps today's access: every record, every field.
 * - The one check is `ownerScope`: the owners whose records a caller sees on
 *   an object, or null for all. Lists, search and reports push it down to the
 *   record service as a predicate; a single record is admitted by
 *   `canSeeRecord`, which reads the same scope.
 *
 * Pure: no database access, no Node-only imports.
 */
import { ConvexError } from "convex/values";
import { ownerAdmitted, type OwnerScope } from "./objects/listSpec.ts";
import { baseFields, isCustomObjectName, STANDARD_OBJECTS } from "./objects/registry.ts";
import { ACTIVITY_OBJECT, ACTIVITY_TYPES } from "./objects/reportSpec.ts";

export type Role = "admin" | "manager" | "rep" | "other";
/** A member's role: a built-in Role, or a workspace's own (orgRoles.key, lib/roles.ts). */
export type RoleKey = string;
/** The roles an admin configures. Admins are not configurable: they see and change everything. */
export const CONFIGURABLE_ROLES = ["manager", "rep", "other"] as const satisfies readonly Role[];
export type ConfigurableRole = (typeof CONFIGURABLE_ROLES)[number];

export type Visibility = "all" | "team" | "own";
export const VISIBILITIES: readonly Visibility[] = ["all", "team", "own"];
export type FieldLevel = "hidden" | "readOnly";
export type RecordOp = "read" | "create" | "edit" | "delete";

/** The owner field visibility reads on every object that has one. */
export const OWNER_FIELD = "ownerId";

/** One role's permission on one object, as stored. A missing key keeps the default. */
export type ObjectRule = {
  object: string;
  visibility?: Visibility;
  /** Under `team` or `own`, whether records with no owner are seen too. */
  unowned?: boolean;
  read?: boolean;
  create?: boolean;
  edit?: boolean;
  delete?: boolean;
  fields?: Array<{ apiName: string; level: FieldLevel }>;
};

export type ObjectPermission = {
  visibility: Visibility;
  unowned: boolean;
  read: boolean;
  create: boolean;
  edit: boolean;
  delete: boolean;
  fields: Readonly<Record<string, FieldLevel>>;
};

/** Today's access: every record and field, every operation (the role's own write rules still apply on top). */
export const FULL_PERMISSION: ObjectPermission = Object.freeze({
  visibility: "all", unowned: true, read: true, create: true, edit: true, delete: true, fields: Object.freeze({}),
});

export type Access = {
  /** The user whose records "own" means. In a preview, the member being previewed. */
  userId: string;
  role: RoleKey;
  /** The owners `team` visibility admits: the user and everyone on a team they belong to or lead. */
  teamOwners: readonly string[];
  /** The role's rules by object; empty for admins and for roles with no policy. */
  rules: Readonly<Record<string, ObjectRule>>;
  /** Set while an admin previews another member: reads as that member, every write refused. */
  preview?: { adminId: string; asUserId: string; asName: string };
};

export type TeamInput = { memberIds: readonly string[]; leadId?: string | null };

/** A caller's access from their role, their role's stored rules and the teams of the workspace. */
export function accessOf(input: { userId: string; role: RoleKey; rules?: readonly ObjectRule[] | null; teams?: readonly TeamInput[]; preview?: Access["preview"] }): Access {
  const mine = (input.teams ?? []).filter((t) => t.leadId === input.userId || t.memberIds.includes(input.userId));
  const teamOwners = [...new Set([input.userId, ...mine.flatMap((t) => [...t.memberIds, ...(t.leadId ? [t.leadId] : [])])])];
  const rules = input.role === "admin" ? {} : Object.fromEntries((input.rules ?? []).map((r) => [r.object, r]));
  return { userId: input.userId, role: input.role, teamOwners, rules, ...(input.preview ? { preview: input.preview } : {}) };
}

/** The caller's permission on an object: its rule over the full default. Admins always have full access. */
export function permissionOf(access: Access, object: string): ObjectPermission {
  const rule = access.role === "admin" ? undefined : access.rules[object];
  if (!rule) return FULL_PERMISSION;
  return {
    visibility: rule.visibility ?? "all",
    unowned: rule.unowned ?? true,
    read: rule.read ?? true,
    create: rule.create ?? true,
    edit: rule.edit ?? true,
    delete: rule.delete ?? true,
    fields: Object.fromEntries((rule.fields ?? []).map((f) => [f.apiName, f.level])),
  };
}

/**
 * The one check: the owners whose records of `object` the caller sees, or
 * null for every record. `hasOwner` says whether the object has an owner
 * field; an object without one is seen whole or, without read, not at all.
 * A role that may not read an object sees nothing of it.
 */
export function ownerScope(access: Access, object: string, hasOwner: boolean): OwnerScope | null {
  const p = permissionOf(access, object);
  if (!p.read) return { field: OWNER_FIELD, owners: [], unowned: false };
  if (p.visibility === "all" || !hasOwner) return null;
  return { field: OWNER_FIELD, owners: p.visibility === "own" ? [access.userId] : [...access.teamOwners], unowned: p.unowned };
}

/** Whether the caller sees one record of `object` owned by `owner`: the same scope a list pushes down, read the same way. */
export function canSeeRecord(access: Access, object: string, hasOwner: boolean, owner: unknown): boolean {
  return ownerAdmitted(ownerScope(access, object, hasOwner), owner);
}

/** Whether the caller may perform `op` on records of `object`. A preview never writes. */
export function may(access: Access, object: string, op: RecordOp): boolean {
  if (access.preview && op !== "read") return false;
  return permissionOf(access, object)[op];
}

/** How the caller may use one field of `object`. */
export function fieldLevel(access: Access, object: string, apiName: string): FieldLevel | "editable" {
  return permissionOf(access, object).fields[apiName] ?? "editable";
}

/** The fields of `object` the caller may not see. */
export function hiddenFields(access: Access, object: string): string[] {
  return Object.entries(permissionOf(access, object).fields).filter(([, l]) => l === "hidden").map(([f]) => f);
}

/** The fields of `object` the caller may not change: hidden or read-only. */
export function lockedFields(access: Access, object: string): string[] {
  return Object.keys(permissionOf(access, object).fields);
}

/**
 * Objects whose records have an owner, so `team` and `own` visibility apply:
 * every standard object with an `ownerId` and every custom object (whose base
 * fields include it). Its fieldId is its apiName, as for every base field.
 */
export function hasOwnerField(object: string): boolean {
  if (!Object.hasOwn(STANDARD_OBJECTS, object) && !isCustomObjectName(object)) return false;
  return baseFields(object).some((f) => f.apiName === OWNER_FIELD);
}

/**
 * The scope of `object` for a list, search or report, by its owner field.
 * Activities (a report over notes, tasks, calls and meetings as one) share one
 * scope: a role whose four rules differ is refused rather than shown more of
 * one type than its rule allows. Deals are scoped by id, from their Convex
 * rows (convex/permissions.ts dealIdScope), not here.
 */
export function scopeFor(access: Access, object: string): OwnerScope | null {
  if (object !== ACTIVITY_OBJECT) return ownerScope(access, object, hasOwnerField(object));
  const scopes = ACTIVITY_TYPES.map((t) => ownerScope(access, t, hasOwnerField(t)));
  const key = (s: OwnerScope | null) => JSON.stringify(s && { ...s, owners: [...s.owners].sort() });
  if (scopes.some((s) => key(s) !== key(scopes[0]))) throw new ConvexError("Activity reports need one visibility for notes, tasks, calls and meetings; ask an admin");
  return scopes[0];
}

/** Whether the caller's role narrows what they read of any object: some visibility below all, an object they may not read, or a hidden field. */
export function narrowsReads(access: Access): boolean {
  return Object.keys(access.rules).some((object) => {
    const p = permissionOf(access, object);
    return !p.read || p.visibility !== "all" || Object.values(p.fields).includes("hidden");
  });
}

/** The keys duplicates match on and a merge compares, beside each object's title. */
const IDENTITY_FIELDS: Readonly<Record<string, readonly string[]>> = {
  account: ["domain", "linkedinUrl"], contact: ["email", "additionalEmails", "linkedinUrl"], lead: ["firstName"],
};

/**
 * Fields a role may make read-only but not hide: the record's title, which
 * every list, search hit, link and timeline shows, and the keys duplicates
 * match on, which their evidence repeats. `titleField` names a custom
 * object's title (a standard object's is known here).
 */
export function unhideableFields(object: string, titleField?: string): string[] {
  const standard = (STANDARD_OBJECTS as Record<string, { titleField: string } | undefined>)[object]?.titleField;
  return [...new Set([...(standard ? [standard] : []), ...(titleField ? [titleField] : []), ...(IDENTITY_FIELDS[object] ?? [])])];
}

/**
 * A copy of `values` without the fields of `object` hidden from the caller.
 * Values are keyed by apiName, which is also the fieldId of every standard
 * field and every custom field the field builder makes (`custom.<slug>`).
 */
export function withoutHidden<T extends Record<string, unknown>>(access: Access, object: string, values: T): T {
  const hidden = hiddenFields(access, object);
  if (!hidden.length) return values;
  const out = { ...values };
  for (const f of hidden) delete out[f];
  return out;
}

/** Refuse a read that names a hidden field (a filter, sort, group or measure would reveal its values). */
export function refuseHiddenUse(access: Access, object: string, fields: ReadonlyArray<string | undefined>) {
  const hidden = new Set(hiddenFields(access, object));
  const used = fields.find((f) => f !== undefined && hidden.has(f));
  if (used) throw new ConvexError(`${used} is hidden for your role`);
}

/** Refuse a write that sets a field the caller may not change: hidden or read-only for their role. */
export function refuseLockedWrite(access: Access, object: string, fields: Iterable<string>) {
  const locked = new Set(lockedFields(access, object));
  for (const f of fields) if (locked.has(f)) throw new ConvexError(`${f} is ${fieldLevel(access, object, f) === "hidden" ? "hidden" : "read-only"} for your role`);
}

/** Whether the caller may set `field` on records of `object`: they may edit the object and the field is neither hidden nor read-only for them. */
export function mayWriteField(access: Access, object: string, field: string): boolean {
  return may(access, object, "edit") && fieldLevel(access, object, field) === "editable";
}

/**
 * Whether the caller sees every record of `object`. A result matched against
 * the whole workspace (a staged fill's "already in your CRM") tells whether a
 * record exists, so only such a caller is shown it.
 */
export function seesEveryRecord(access: Access, object: string): boolean {
  return ownerScope(access, object, hasOwnerField(object)) === null;
}

/**
 * Refuse a whole-workspace operation (an import, a sync, a plan or score
 * built from the whole CRM mirror) to a caller who sees only part of the
 * workspace, or who is previewing someone: it would read or write records
 * their role hides. Roles with no rules are unaffected.
 */
export function refuseNarrowed(access: Access, what: string) {
  if (access.preview) throw new ConvexError(`You are viewing as ${access.preview.asName}: ${what} is off until you exit the preview`);
  if (narrowsReads(access)) throw new ConvexError(`Your role sees only some records, so ${what} is not available to it; ask an admin`);
}

/** Whether any rule narrows anything: false means the caller has today's full access. */
export function isRestricted(access: Access): boolean {
  return access.preview !== undefined || Object.keys(access.rules).length > 0;
}

/**
 * The records two scopes of one object both admit, or null when both admit
 * every record. One object has one owner field (`ownerId`, or `id` for a
 * deal's id scope), so both scopes name the same field.
 */
export function intersectScopes(a: OwnerScope | null, b: OwnerScope | null): OwnerScope | null {
  if (!a) return b;
  if (!b) return a;
  if (a.field !== b.field) throw new ConvexError(`Two visibility scopes name different fields (${a.field}, ${b.field})`);
  const inB = new Set(b.owners);
  return { field: a.field, owners: a.owners.filter((o) => inB.has(o)), unowned: a.unowned && b.unowned };
}

/**
 * Whom an agent run reads and writes as (CP14): its principals. An agent has
 * one accountable owner (`agents.ownerUserId`; an AI field not yet linked to
 * its agent is owned by its creator, who becomes that owner on link). A run
 * someone else started, or a test turn, also reads as that person, so it
 * returns nothing either of them could not see. There is no principal-less
 * run: a run whose principals cannot be resolved does not run.
 */
export function agentPrincipals(a: { ownerUserId: string; startedBy?: string | null }): string[] {
  return [...new Set([a.ownerUserId, ...(a.startedBy ? [a.startedBy] : [])])];
}

/**
 * Whether a viewer sees which records an agent run read (its misses, its
 * probe's sample, a turn's account and answers): one of the run's principals,
 * whose reads it was scoped to, or a viewer whose role narrows no read. Anyone
 * else sees only its counts. A "view as" preview judges the member previewed.
 */
export function seesRunRecords(viewer: Access, principals: readonly string[]): boolean {
  return principals.includes(viewer.userId) || !narrowsReads(viewer);
}
