type User = { _id: string; managerId?: string | null };

/**
 * Whose records "My team" reads: the caller and everyone who reports to them, directly or not; a caller no one
 * reports to reads their team, everyone who shares their manager. "Me" reads the caller's own.
 */
export function scopeOwners(scope: "me" | "team", me: string, users: readonly User[]): string[] {
  if (scope === "me") return [me];
  const below = new Set<string>([me]);
  for (let grew = true; grew;) {
    grew = false;
    for (const u of users) if (u.managerId && below.has(u.managerId) && !below.has(u._id)) { below.add(u._id); grew = true; }
  }
  if (below.size > 1) return [...below];
  const manager = users.find((u) => u._id === me)?.managerId;
  return manager ? [me, ...users.filter((u) => u._id !== me && u.managerId === manager).map((u) => u._id)] : [me];
}
