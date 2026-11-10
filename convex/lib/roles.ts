/**
 * A workspace's own roles, beside the built-in admin, manager, rep and other. A role has a name, the built-in role it
 * counts as wherever Canon asks what kind of member someone is (who can manage reps, who owns an agent), and the
 * capabilities it holds (modules/kernel/capabilities.ts), never an adminOnly one. Its record rules are a rolePermissions row,
 * as a built-in role's are.
 *
 * Pure: no database access, no Node-only imports.
 */
import { CAPABILITIES, type Capability } from "../../modules/kernel/capabilities.ts";

export const BUILT_IN_ROLES = ["admin", "manager", "rep", "other"] as const;
export const ROLE_BASES = ["manager", "rep", "other"] as const;
export type RoleBase = (typeof ROLE_BASES)[number];
export type OrgRole = { key: string; name: string; base: RoleBase; capabilities: readonly string[] };

export const isBuiltInRole = (key: string) => (BUILT_IN_ROLES as readonly string[]).includes(key);

/** What kind of member a role makes someone: a built-in role is itself, a workspace's own counts as its base. */
export const baseRole = (key: string, bases: Readonly<Record<string, string>>): string => (isBuiltInRole(key) ? key : bases[key] ?? "other");

/** The capabilities a workspace may give its own roles: every one that isn't adminOnly. */
export const GRANTABLE: readonly Capability[] = (Object.keys(CAPABILITIES) as Capability[]).filter((c) => !("adminOnly" in CAPABILITIES[c]));

const BUILT_IN_NAMES = ["admin", "admins", "manager", "managers", "rep", "reps", "other", "other members"];
const NAME_MAX = 40;

/** A role as an admin defines or edits it, checked: a fresh name, a base, grantable capabilities. `key` keeps an existing role's. */
export function defineRole(spec: { name: string; base: string; capabilities: readonly string[] }, existing: readonly OrgRole[], key?: string): OrgRole {
  const name = spec.name.trim().replace(/\s+/g, " ");
  if (!name) throw new Error("A role needs a name");
  if (name.length > NAME_MAX) throw new Error(`A role's name is at most ${NAME_MAX} characters`);
  if (BUILT_IN_NAMES.includes(name.toLowerCase()) || existing.some((r) => r.key !== key && r.name.toLowerCase() === name.toLowerCase())) throw new Error(`There is already a role named ${name}`);
  if (!(ROLE_BASES as readonly string[]).includes(spec.base)) throw new Error(`${spec.base} is not a role to count as`);
  const unknown = spec.capabilities.filter((c) => !(GRANTABLE as readonly string[]).includes(c));
  if (unknown.length) throw new Error(`A workspace role can't hold ${unknown.join(", ")}`);
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 30) || "role";
  let next = key ?? `role_${slug}`;
  for (let n = 2; !key && existing.some((r) => r.key === next); n++) next = `role_${slug}_${n}`;
  return { key: next, name, base: spec.base as RoleBase, capabilities: [...new Set(spec.capabilities)] };
}
