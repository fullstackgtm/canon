/**
 * Audiences for outbound (GT6): the contact shape that leaves Canon, the CSV
 * it exports as, and the plan for a push (who goes, who is skipped and why).
 *
 * Pure: no database access, no Node-only imports.
 */

/** A contact as it leaves Canon. `custom` holds the contact's non-standard fields, keyed by merge-variable name. */
export type OutboundContact = {
  id: string;
  email: string | null;
  fullName: string;
  title: string | null;
  company: string | null;
  phone: string | null;
  linkedinUrl: string | null;
  /** A person's emails and phones beside the primary ones (#299). */
  otherEmails?: readonly string[];
  otherPhones?: readonly string[];
  custom: Record<string, string | number | boolean>;
};

/** Contacts one audience may hold: a push reads every one of them. */
export const AUDIENCE_MAX = 25_000;

const BASE_COLUMNS = ["email", "first_name", "last_name", "company", "title", "phone", "linkedin_url"] as const;

export function splitName(fullName: string): { first: string; last: string } {
  const [first = "", ...rest] = fullName.trim().split(/\s+/);
  return { first, last: rest.join(" ") };
}

/**
 * A custom field's name as a merge variable: `custom.deep_link` becomes
 * `deep_link`, anything outside letters, digits and `_` becomes `_`, and a name
 * that would shadow a standard column gets a `custom_` prefix.
 */
export function variableName(apiName: string): string {
  const name = apiName.replace(/^custom\./, "").replace(/[^A-Za-z0-9_]+/g, "_").replace(/^_+|_+$/g, "") || "field";
  return (BASE_COLUMNS as readonly string[]).includes(name) ? `custom_${name}` : name;
}

export const emailKey = (email: string | null | undefined) => (email ?? "").trim().toLowerCase();

/** Spreadsheets run a cell that starts with these as a formula; a leading quote makes it text. Phone numbers (+1 ...) stay as they are. */
const FORMULA_START = /^(?:[=@\t\r]|[+-](?![\d\s.()-]*$))/;

function cell(value: unknown): string {
  let text = value === null || value === undefined ? "" : String(value);
  if (FORMULA_START.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/**
 * The audience as CSV: the standard columns (the primary email and phone), a person's others when any contact
 * has them (semicolon-separated, as an import reads them back), then one column per custom variable any contact has.
 */
export function csvOf(contacts: readonly OutboundContact[]): string {
  const custom = [...new Set(contacts.flatMap((c) => Object.keys(c.custom)))].sort();
  const lists = ([["other_emails", "otherEmails"], ["other_phones", "otherPhones"]] as const).filter(([, k]) => contacts.some((c) => c[k]?.length));
  const rows = contacts.map((c) => {
    const { first, last } = splitName(c.fullName);
    return [c.email, first, last, c.company, c.title, c.phone, c.linkedinUrl, ...lists.map(([, k]) => (c[k] ?? []).join("; ")), ...custom.map((k) => c.custom[k])];
  });
  return [[...BASE_COLUMNS, ...lists.map(([name]) => name), ...custom], ...rows].map((row) => row.map(cell).join(",")).join("\r\n") + "\r\n";
}

export type PushPlan = {
  /** Contacts to send: one per email, not already sent to this target. */
  send: OutboundContact[];
  noEmail: OutboundContact[];
  /** A second contact with an email an earlier one already has. */
  duplicates: OutboundContact[];
  alreadySent: OutboundContact[];
};

/** Who a push would send. `sent` holds the lowercase emails already sent to the same target. */
export function planPush(contacts: readonly OutboundContact[], sent: ReadonlySet<string>): PushPlan {
  const plan: PushPlan = { send: [], noEmail: [], duplicates: [], alreadySent: [] };
  const seen = new Set<string>();
  for (const c of contacts) {
    const key = emailKey(c.email);
    if (!key) plan.noEmail.push(c);
    else if (seen.has(key)) plan.duplicates.push(c);
    else {
      seen.add(key);
      (sent.has(key) ? plan.alreadySent : plan.send).push(c);
    }
  }
  return plan;
}

export const summaryOf = (plan: PushPlan) => ({
  total: plan.send.length + plan.noEmail.length + plan.duplicates.length + plan.alreadySent.length,
  toSend: plan.send.length,
  skippedNoEmail: plan.noEmail.length,
  skippedDuplicate: plan.duplicates.length,
  alreadySent: plan.alreadySent.length,
});

/** Every page of a paged read, in order: the push dedupe must see all earlier sends, not a first slice. */
export async function readAll<T>(page: (cursor: string | null) => Promise<{ items: T[]; next: string | null }>): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | null = null;
  do {
    const { items, next } = await page(cursor);
    out.push(...items);
    cursor = next;
  } while (cursor);
  return out;
}

export type HistoryRow = { target: string; at: number; outcome: "sent" | "exported" | "skipped" };

/**
 * Newest-first member rows as runs (one per target and time). When the read was cut short, the oldest
 * run may be partly missing, so it is left out rather than shown with wrong counts.
 */
export function runsOf(rows: readonly HistoryRow[], cut: boolean) {
  const runs = new Map<string, { target: string; at: number; sent: number; exported: number; skipped: number }>();
  for (const r of rows) {
    const key = `${r.target}@${r.at}`;
    const run = runs.get(key) ?? { target: r.target, at: r.at, sent: 0, exported: 0, skipped: 0 };
    run[r.outcome] += 1;
    runs.set(key, run);
  }
  const last = rows.at(-1);
  if (cut && last) runs.delete(`${last.target}@${last.at}`);
  return [...runs.values()];
}
