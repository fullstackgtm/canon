/**
 * Whether a member holds a capability: what a role may do beyond its record rules (lib/access.ts). The capabilities,
 * and the built-in roles that hold each, are part of the module contract (modules/kernel/capabilities.ts). Admins hold
 * every capability; an `adminOnly` one is never granted to anyone else, so an admin can't be locked out and unattended
 * work that acts as its creator keeps seeing everything.
 *
 * Every check goes through `can`, never a role name: the one place a capability is decided.
 *
 * Pure: no database access, no Node-only imports.
 */
import { CAPABILITIES, type Capability, type CapabilitySpec } from "../../modules/kernel/capabilities.ts";

/**
 * Whether a member holds `cap`. A built-in role holds what the registry says; a workspace's own role holds the
 * capabilities loaded with the member (lib.ts getCurrentUser), and none when they weren't, so a path that forgets to
 * load them refuses rather than grants. No one but an admin holds an adminOnly capability.
 */
export function can(who: { role: string; capabilities?: readonly string[] }, cap: Capability): boolean {
  if (who.role === "admin") return true;
  const spec: CapabilitySpec = CAPABILITIES[cap];
  if (["manager", "rep", "other"].includes(who.role)) return (spec.roles as readonly string[]).includes(who.role);
  return !spec.adminOnly && (who.capabilities ?? []).includes(cap);
}

/** Why a member without `cap` can't go on, as a sentence. */
export const refusal = (cap: Capability) => `Your role can't do this: ${CAPABILITIES[cap].label.toLowerCase()}`;
