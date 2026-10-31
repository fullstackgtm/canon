/**
 * Settings > Team deep links: the query keys a link (a module's `canon: "team"` link, or a person) may send.
 * `search`, `manager`, `title`, `team`, `role`, `status` are the page's own; any other key names a column a module
 * contributes, by its label ("Plans" answers `?plans=` and `?plan=`), or `?col=<label>&value=<value>`.
 */
export const OWN_KEYS = ["search", "manager", "title", "team", "group", "hidden", "role", "status", "tab", "col", "value"] as const;

/** A contributed column's filter value for the members it shows no value for. */
export const NO_VALUE = "#none";

export type LinkColumn = { id: string; label: string; values: Record<string, string[]>; keys?: Record<string, string> };
type Params = { get(key: string): string | null; keys(): Iterable<string> };

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** The query keys that name a contributed column: its label's slug, and that without a plural s. */
export function columnKeys(label: string): string[] {
  const s = slug(label);
  if ((OWN_KEYS as readonly string[]).includes(s)) return [];
  return s.endsWith("s") && s.length > 1 ? [s, s.slice(0, -1)] : [s];
}

/**
 * A linked value as the column shows it: the same text in any case, or the text whose doc key it is (`keys`, value
 * to key, when the column carries them), or `none` for the members with no value. Unknown values are kept, so the link
 * filters to no one rather than everyone.
 */
export function resolveColumnValue(col: LinkColumn, want: string): string {
  const shown = [...new Set(Object.values(col.values).flat())];
  const w = want.trim().toLowerCase();
  const byText = shown.find((v) => v.toLowerCase() === w);
  if (byText) return byText;
  const byKey = Object.entries(col.keys ?? {}).find(([, key]) => key === want.trim());
  if (byKey) return byKey[0];
  // `none`: the members the column says nothing for ("No plans"), as its filter's own "No …" option.
  return w === "none" ? NO_VALUE : want.trim();
}

/** The contributed-column filters a URL asks for, by column id. */
export function linkedColumnFilters(params: Params, columns: readonly LinkColumn[]): Record<string, string> {
  const out: Record<string, string> = {};
  const col = params.get("col");
  const value = params.get("value");
  for (const c of columns) {
    const keys = columnKeys(c.label);
    let want = keys.map((k) => params.get(k)).find((v) => v);
    if (!want && col && value && keys.includes(slug(col))) want = value;
    if (want) out[c.id] = resolveColumnValue(c, want);
  }
  return out;
}

/** Whether a member answers `?manager=`: their manager's id, their manager's name (any case), or `none`. */
export function managerMatches(want: string, member: { managerId?: string | null; managerName: string | null }): boolean {
  if (!want) return true;
  if (want === "none") return !member.managerId;
  if (member.managerId === want) return true;
  return (member.managerName ?? "").toLowerCase() === want.trim().toLowerCase();
}

/** The query keys Clear filters drops: every one but the tab, the grouping and showing hidden members. */
export function clearableKeys(params: Params): string[] {
  return [...params.keys()].filter((k) => !["tab", "group", "hidden"].includes(k));
}
