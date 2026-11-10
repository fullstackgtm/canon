type Value = string | number | boolean | null | undefined;
export type ContactTableRow = { id: string; fullName: string; title?: string | null; email?: string | null; accountId?: string | null };
export type ContactTableField = { slug: string; options?: { key: string; label: string }[] | null };
export type ContactTableAnswers = Record<string, Record<string, { value: Value }>>;
export type ContactTableControls = { sort: string; descending: boolean; field: string; query: string; missing: boolean };

export function contactTableValue(row: ContactTableRow, field: string, names: Record<string, string>, fields: readonly ContactTableField[], answers: ContactTableAnswers | undefined): Value {
  if (field.startsWith("ai:")) {
    const slug = field.slice(3);
    const value = answers?.[row.id]?.[slug]?.value;
    return fields.find((f) => f.slug === slug)?.options?.find((o) => o.key === value)?.label ?? value;
  }
  if (field === "account") return row.accountId ? names[row.accountId] ?? row.accountId : null;
  if (field === "fullName" || field === "title" || field === "email") return row[field];
  return null;
}

const text = (value: Value) => value == null ? "" : typeof value === "boolean" ? (value ? "Yes" : "No") : String(value);
const absent = (value: Value) => value == null || value === "";

/** A local view only: never changes the server search or starts research. */
export function contactTableRows<T extends ContactTableRow>(rows: readonly T[], names: Record<string, string>, fields: readonly ContactTableField[], answers: ContactTableAnswers | undefined, controls: ContactTableControls): T[] {
  const value = (row: T, field: string) => contactTableValue(row, field, names, fields, answers);
  const query = controls.query.trim().toLocaleLowerCase();
  const filtered = rows.filter((row) => !controls.field || (controls.missing
    ? absent(value(row, controls.field))
    : text(value(row, controls.field)).toLocaleLowerCase().includes(query)));
  if (!controls.sort) return filtered;
  return filtered.sort((a, b) => {
    const av = value(a, controls.sort), bv = value(b, controls.sort);
    // Keep unanswered cells last in either direction.
    if (absent(av) || absent(bv)) return Number(absent(av)) - Number(absent(bv));
    const order = typeof av === "number" && typeof bv === "number" ? av - bv : text(av).localeCompare(text(bv), undefined, { numeric: true, sensitivity: "base" });
    return controls.descending ? -order : order;
  });
}

/** Match the contactAnswers query's per-request bound without dropping loaded rows. */
export function contactAnswerBatches(ids: readonly string[]): string[][] {
  const batches: string[][] = [];
  for (let i = 0; i < ids.length; i += 500) batches.push(ids.slice(i, i + 500));
  return batches;
}

export function contactQuickTestIds(rows: readonly ContactTableRow[]): string[] {
  return rows.slice(0, 5).map((row) => row.id);
}
