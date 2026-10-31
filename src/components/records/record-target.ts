export type RecordTarget = { object: string; id: string };

export const recordHref = (object: string, id: string) =>
  object === "account" ? `/dashboard/accounts/${encodeURIComponent(id)}` : `/dashboard/records/${encodeURIComponent(object)}/${encodeURIComponent(id)}`;

/** Objects whose list is a page of its own. A list is named for its object (`plural`, as the workspace calls it), except My work. */
const LISTS = new Map<string, { href: string; label?: string }>([
  ["account", { href: "/dashboard/accounts" }],
  ["contact", { href: "/dashboard/contacts" }],
  ["deal", { href: "/dashboard/deals" }],
  ["task", { href: "/dashboard/tasks", label: "My work" }],
]);

export const recordListOf = (object: string, plural: string): { href: string; label: string } => {
  const list = LISTS.get(object);
  return { href: list?.href ?? `/dashboard/records/${encodeURIComponent(object)}`, label: list?.label ?? plural };
};

export function inspectionTarget(params: Pick<URLSearchParams, "get">, pathname = ""): RecordTarget | null {
  const object = params.get("peekObject"), id = params.get("peekId");
  if (object && id) return { object, id };
  const legacyId = params.get("record");
  const listObject = pathname === "/dashboard/deals" ? "deal" : /^\/dashboard\/records\/([^/]+)$/.exec(pathname)?.[1];
  if (!legacyId || !listObject) return null;
  try { return { object: decodeURIComponent(listObject), id: legacyId }; } catch { return null; }
}

export function inspectionHref(pathname: string, search: string, target: RecordTarget | null): string {
  const params = new URLSearchParams(search);
  params.delete("record");
  if (target) {
    params.set("peekObject", target.object);
    params.set("peekId", target.id);
  } else {
    params.delete("peekObject");
    params.delete("peekId");
  }
  // Not `params.size`: Safari before 17 has no such property, so every href would lose its query.
  const query = params.toString();
  return query ? `${pathname}?${query}` : pathname;
}
