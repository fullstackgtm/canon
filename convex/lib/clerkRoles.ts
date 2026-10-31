type AppRole = "admin" | "manager" | "rep" | "other";

/** Clerk org role -> app role. Shared by the Clerk webhook and the backfill. */
export function mapClerkRole(role: string): AppRole {
  if (role === "org:admin" || role === "admin") return "admin";
  return "rep";
}

/**
 * The role a Clerk membership event leaves a member with. Clerk decides only who is an admin; every other role is
 * Canon's, set on the Team page, so an event for a manager keeps them a manager. Someone Clerk no longer calls an
 * admin becomes a rep.
 */
export function syncedRole(fromClerk: AppRole, stored: string | undefined): string {
  if (fromClerk === "admin") return "admin";
  return !stored || stored === "admin" ? fromClerk : stored;
}

/** A record nobody signs in as yet: added in Canon, or a CRM owner from a sync. An invite to its email takes it over. */
export const awaitsLogin = (clerkUserId: string) => /^(member|hubspot|salesforce):/.test(clerkUserId);
