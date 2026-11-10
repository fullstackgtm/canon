/**
 * Field consolidation (docs/field-consolidation.md): one business concept (industry) lives in several CRM columns
 * across objects and systems. This is the pure part: which columns hold a concept, how full and how consistent they
 * are, how source values map onto the standard column's picklist, and what each record would get.
 * Pure and runtime-neutral: Convex actions, queries, the page and tests import it.
 */

export type CrmSystem = "hubspot" | "salesforce";
export type ColumnObject = "companies" | "contacts" | "Account" | "Contact" | "Lead";
/** Records an account-level column describes (a company) or a person-level one (a contact or lead). */
export type ColumnLevel = "account" | "person";

export const COLUMN_OBJECTS: Record<ColumnObject, { system: CrmSystem; level: ColumnLevel; label: string; writable: boolean }> = {
  companies: { system: "hubspot", level: "account", label: "HubSpot companies", writable: true },
  contacts: { system: "hubspot", level: "person", label: "HubSpot contacts", writable: true },
  Account: { system: "salesforce", level: "account", label: "Salesforce Accounts", writable: true },
  Contact: { system: "salesforce", level: "person", label: "Salesforce Contacts", writable: true },
  // Canon's Salesforce connector writes Accounts, Contacts and Opportunities only: Lead columns are read-only sources.
  Lead: { system: "salesforce", level: "person", label: "Salesforce Leads", writable: false },
};

export const OBJECTS_BY_SYSTEM: Record<CrmSystem, ColumnObject[]> = {
  hubspot: ["companies", "contacts"],
  salesforce: ["Account", "Contact", "Lead"],
};

/**
 * The properties on a HubSpot record that say Salesforce owns it (set by HubSpot's Salesforce integration): a contact
 * synced with a Salesforce Lead carries `salesforceleadid`, one synced with a Contact `salesforcecontactid`.
 */
export const HUBSPOT_SALESFORCE_LINK: Partial<Record<ColumnObject, readonly string[]>> = {
  companies: ["salesforceaccountid"],
  contacts: ["salesforcecontactid", "salesforceleadid"],
};

/** Whether Salesforce owns this HubSpot record, so it is never written in HubSpot. */
export function salesforceOwned(object: ColumnObject, values: Record<string, unknown>): boolean {
  return (HUBSPOT_SALESFORCE_LINK[object] ?? []).some((p) => cleanValue(values[p]) !== null);
}

export type ColumnOption = { label: string; value: string };
export type Column = {
  key: string;
  object: ColumnObject;
  name: string;
  label: string;
  kind: "picklist" | "text" | "number";
  options: ColumnOption[];
  /** HubSpot-defined or Salesforce standard, as opposed to one the org added. */
  standard: boolean;
  /** A calculated or otherwise read-only CRM column: a source, never the standard. */
  readOnly?: boolean;
  /** Decimal places a number column keeps (Salesforce `scale`); unknown for HubSpot. */
  decimals?: number;
  /** A free-fill enrichment source's value for a HubSpot company (`@pdl.industry`), not a CRM column: never written. */
  enrichment?: EnrichmentSource;
};

/**
 * What a standard column holds, and so how sources become its value: a category (a picklist: source values map onto
 * its options, the first source that maps decides) or a quantity (a number: source values are read as amounts and
 * scaled, and the sources combine by the policy's method).
 */
export type Measure = "category" | "quantity";
export const measureOf = (column: Pick<Column, "kind">): Measure => (column.kind === "number" ? "quantity" : "category");
/** Whether a column can be the standard: one value of a known set, or an amount. */
export const standardKind = (column: Pick<Column, "kind" | "readOnly">) => (column.kind === "picklist" || column.kind === "number") && !column.readOnly;

/**
 * Bumped when discovery starts keeping columns it used to skip (2: number columns). A Canon field whose columns were
 * read by an older version reads them again when its page opens.
 */
export const DISCOVERY_VERSION = 2;

export const columnKey = (object: ColumnObject, name: string) => `${object}.${name}`;
export const parseColumnKey = (key: string): { object: ColumnObject; name: string } => {
  const at = key.indexOf(".");
  return { object: key.slice(0, at) as ColumnObject, name: key.slice(at + 1) };
};

const SYNONYMS: Record<string, string[]> = {
  industry: ["sector", "vertical"],
  revenue: ["turnover"],
  employees: ["headcount", "employee"],
};

/** The words a concept matches in a column's name or label: its own words plus known synonyms. */
export function conceptKeywords(concept: string): string[] {
  const words = concept.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);
  return [...new Set(words.flatMap((w) => [w, ...(SYNONYMS[w] ?? [])]))];
}

export function matchesConcept(field: { name: string; label: string }, keywords: readonly string[]): boolean {
  const text = `${field.name} ${field.label}`.toLowerCase();
  return keywords.some((k) => text.includes(k));
}

// ── Enrichment columns ───────────────────────────────────────────────────────

export type EnrichmentSource = "pdl" | "crustdata";
const ENRICHMENT_LABEL: Record<EnrichmentSource, string> = { pdl: "PDL", crustdata: "Crustdata" };

/** The raw values free fill matched for a company (enrichmentMatches), before any mapping. */
export type EnrichmentValues = {
  industry?: string;
  numberofemployees?: number;
  annualrevenue?: number;
  city?: string;
  state?: string;
  country?: string;
  linkedin_company_page?: string;
  founded_year?: number;
};
export type EnrichmentField = keyof EnrichmentValues;

/**
 * Each free-fill field: its label, the concept words that name it, and the sources that hold it. Crustdata identify
 * has no location; revenue comes from SEC filings or an estimate, neither of them a matched source's own value.
 */
export const ENRICHMENT_FIELDS: Record<EnrichmentField, { label: string; concepts: readonly string[]; sources: readonly EnrichmentSource[]; number?: true }> = {
  industry: { label: "industry", concepts: ["industry", "sector", "vertical"], sources: ["pdl", "crustdata"] },
  numberofemployees: { label: "employees", concepts: ["employees", "headcount", "size"], sources: ["pdl", "crustdata"], number: true },
  annualrevenue: { label: "annual revenue", concepts: ["revenue", "turnover"], sources: [], number: true },
  city: { label: "city", concepts: ["city", "town", "locality"], sources: ["pdl"] },
  state: { label: "state", concepts: ["state", "region", "province"], sources: ["pdl"] },
  country: { label: "country", concepts: ["country", "nation"], sources: ["pdl"] },
  linkedin_company_page: { label: "LinkedIn page", concepts: ["linkedin"], sources: ["pdl", "crustdata"] },
  founded_year: { label: "year founded", concepts: ["founded", "founding", "established"], sources: ["pdl", "crustdata"], number: true },
};

export const isEnrichmentName = (name: string) => name.startsWith("@");

/** The free-fill fields a concept's keywords name. */
export function enrichmentFieldsFor(keywords: readonly string[]): EnrichmentField[] {
  return (Object.keys(ENRICHMENT_FIELDS) as EnrichmentField[]).filter((field) =>
    matchesConcept({ name: ENRICHMENT_FIELDS[field].label, label: ENRICHMENT_FIELDS[field].concepts.join(" ") }, keywords));
}

/** The enrichment columns a consolidation with these keywords reads as sources, on HubSpot companies. */
export function enrichmentColumns(keywords: readonly string[]): Column[] {
  return enrichmentFieldsFor(keywords).flatMap((field) =>
    ENRICHMENT_FIELDS[field].sources.map((source): Column => {
      const name = `@${source}.${field}`;
      return {
        key: columnKey("companies", name), object: "companies", name, label: `${ENRICHMENT_LABEL[source]} ${ENRICHMENT_FIELDS[field].label}`,
        kind: ENRICHMENT_FIELDS[field].number ? "number" : "text", options: [], standard: false, enrichment: source,
      };
    }));
}

/** An enrichment column's value for a record: the match's raw value when the match came from that column's source. */
export function enrichmentValue(name: string, match: { source: EnrichmentSource; values: EnrichmentValues } | null | undefined): string | null {
  const [source, field] = name.slice(1).split(".") as [EnrichmentSource, EnrichmentField];
  const value = match?.source === source ? match.values[field] : undefined;
  return value === undefined ? null : String(value);
}

/** Whether Canon may write this column: its object is writable and it is a CRM column, not an enrichment source. */
export const writableColumn = (column: { object: ColumnObject; name: string }) => COLUMN_OBJECTS[column.object].writable && !isEnrichmentName(column.name);

/**
 * The free-fill properties a Canon field owns, so free fill leaves them to it: the HubSpot company columns it writes
 * (destinations not turned off), and the free-fill fields its concept names. Only a field with a destination owns any.
 */
export function canonOwnedFields<Id extends string>(
  consolidations: ReadonlyArray<{ _id: Id; concept: string; keywords: readonly string[]; target?: string; mirror?: string; destinations?: Destination[] }>,
): Array<{ property: string; concept: string; consolidationId: Id }> {
  const owners = new Map<string, { property: string; concept: string; consolidationId: Id }>();
  for (const c of consolidations) {
    const writes = destinationsOf(c).filter((d) => d.mode !== "off");
    if (!writes.length) continue;
    const columns = writes.map((d) => parseColumnKey(d.column)).filter((col) => col.object === "companies").map((col) => col.name);
    for (const property of [...columns, ...enrichmentFieldsFor(c.keywords)]) {
      if (!owners.has(property)) owners.set(property, { property, concept: c.concept, consolidationId: c._id });
    }
  }
  return [...owners.values()];
}

/** A HubSpot property definition as a column; null for types a consolidation can't read or write as one value. */
export function hubspotColumn(object: ColumnObject, prop: any): Column | null {
  if (!prop?.name || prop.hidden) return null;
  const select = prop.type === "enumeration" && prop.fieldType !== "checkbox" && prop.fieldType !== "booleancheckbox";
  const number = prop.type === "number";
  if (!select && !number && prop.type !== "string") return null;
  return {
    key: columnKey(object, prop.name),
    object,
    name: String(prop.name),
    label: String(prop.label ?? prop.name),
    kind: select ? "picklist" : number ? "number" : "text",
    options: select ? (prop.options ?? []).filter((o: any) => !o.hidden).map((o: any) => ({ label: String(o.label), value: String(o.value) })) : [],
    standard: Boolean(prop.hubspotDefined),
    ...(prop.calculated || prop.modificationMetadata?.readOnlyValue ? { readOnly: true } : {}),
  };
}

const SALESFORCE_NUMBER_TYPES = new Set(["currency", "double", "int", "long", "percent"]);

/** A Salesforce describe field as a column; multi-select picklists and non-text types are skipped. */
export function salesforceColumn(object: ColumnObject, field: any): Column | null {
  if (!field?.name) return null;
  const picklist = field.type === "picklist";
  const number = SALESFORCE_NUMBER_TYPES.has(field.type);
  if (!picklist && !number && field.type !== "string" && field.type !== "textarea") return null;
  return {
    key: columnKey(object, field.name),
    object,
    name: String(field.name),
    label: String(field.label ?? field.name),
    kind: picklist ? "picklist" : number ? "number" : "text",
    options: picklist
      ? (field.picklistValues ?? []).filter((p: any) => p.active !== false).map((p: any) => ({ label: String(p.label ?? p.value), value: String(p.value) }))
      : [],
    standard: !field.custom,
    ...(field.calculated || field.updateable === false ? { readOnly: true } : {}),
    ...(number && typeof field.scale === "number" ? { decimals: field.scale } : {}),
  };
}

/** A value as stored: trimmed, inner whitespace collapsed; empty is null. */
export function cleanValue(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  const value = String(raw).replace(/\s+/g, " ").trim();
  return value ? value : null;
}

/** The key a value maps under: case, punctuation and "&" vs "and" don't make two values different. */
export function mapKey(value: string): string {
  return value.toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim();
}

// ── Quantities ───────────────────────────────────────────────────────────────

/** An amount read from a value, and how exactly the value states it (1 for a plain number, less for a range or bound). */
export type Quantity = { amount: number; confidence: number };

const MULTIPLIER: Record<string, number> = {
  k: 1e3, thousand: 1e3, m: 1e6, mm: 1e6, mn: 1e6, million: 1e6, b: 1e9, bn: 1e9, billion: 1e9, t: 1e12, trillion: 1e12,
};
const AMOUNT = /(\d[\d,]*(?:\.\d+)?|\.\d+)\s*(thousand|million|billion|trillion|mm|mn|bn|k|m|b|t)?(?![a-z])/g;

/**
 * A value as an amount: "23500000", "$23.5M", "1.2 billion", a range ("$10M - $50M", "10-50M": its midpoint), an open
 * bound ("5,000+", "over 1B": the bound), or a number in other words ("about 300 employees"). Null when no amount.
 */
export function parseQuantity(raw: string): Quantity | null {
  const text = raw.toLowerCase().replace(/[$€£¥]|\b(usd|eur|gbp)\b/g, "").trim();
  const plain = Number(text.replace(/,/g, ""));
  if (text && Number.isFinite(plain)) return { amount: plain, confidence: 1 };
  const found = [...text.matchAll(AMOUNT)].map((m) => ({ n: Number(m[1]!.replace(/,/g, "")), unit: m[2], start: m.index!, end: m.index! + m[0].length }));
  if (!found.length || found.some((f) => !Number.isFinite(f.n))) return null;
  const amount = (f: { n: number; unit?: string }, unit = f.unit) => f.n * (unit ? MULTIPLIER[unit]! : 1);
  if (found.length === 2 && /^\s*(-|–|—|to)\s*$/.test(text.slice(found[0]!.end, found[1]!.start))) {
    // "10-50M": the first end of a range takes the second's unit when it has none.
    const low = amount(found[0]!, found[0]!.unit ?? found[1]!.unit);
    return { amount: (low + amount(found[1]!)) / 2, confidence: 0.9 };
  }
  if (found.length !== 1) return null;
  const bound = /\+|\b(over|above|more than|at least)\b|>|\b(under|below|less than|up to)\b|</.test(text);
  return { amount: amount(found[0]!), confidence: bound ? 0.6 : 0.8 };
}

/** Steps per power of ten in a quantity profile's histograms: one step is a factor of about 1.12. */
export const STEPS_PER_DECADE = 20;
const step = (ratio: number) => Math.round(Math.log10(ratio) * STEPS_PER_DECADE);
const fromStep = (s: number) => 10 ** (s / STEPS_PER_DECADE);

/**
 * A column's values read as amounts: how many read, by how exactly (confidence → count), and the positive amounts
 * as a log histogram (step → count) for medians and spreads.
 */
export type QuantityProfile = { read: number; byConfidence: Array<[number, number]>; nonPositive: number; histogram: Array<[number, number]> };

/** The amount at a quantile (0..1) of a histogram's positive values, at the histogram's resolution. */
export function quantile(q: QuantityProfile, at: number): number | null {
  const sorted = [...q.histogram].sort((a, b) => a[0] - b[0]);
  const total = sorted.reduce((s, [, n]) => s + n, 0);
  if (!total) return null;
  let seen = 0;
  for (const [s, n] of sorted) {
    seen += n;
    if (seen >= at * total) return fromStep(s);
  }
  return fromStep(sorted[sorted.length - 1]![0]);
}

/** The share of a column's filled values that read as amounts at least this exactly. */
export function quantityShare(q: QuantityProfile | undefined, filled: number, minConfidence: number): number {
  if (!q || !filled) return 0;
  return q.byConfidence.reduce((s, [c, n]) => s + (c >= minConfidence ? n : 0), 0) / filled;
}

export type Combine = "first" | "mean" | "median" | "min" | "max";
export const COMBINE_LABEL: Record<Combine, string> = {
  first: "First source by priority",
  mean: "Average of the sources",
  median: "Median of the sources",
  min: "Lowest source",
  max: "Highest source",
};

/** A source column's scale into the standard's units (ZoomInfo revenue in thousands is ×1,000). */
export type ScaleEntry = { column: string; factor: number; origin: "auto" | "user" };
export const SCALE_FACTORS = [1e-6, 1e-3, 1, 1e3, 1e6, 1e9] as const;
export const scaleOf = (scales: readonly ScaleEntry[], column: string) => scales.find((e) => e.column === column)?.factor ?? 1;

/**
 * How two columns' amounts compare on the records where both read: log ratios a/b (step → count), a < b by name.
 * `within` is the share within a relative tolerance after scaling each side; `median` is the typical ratio.
 */
export function ratioAgreement(ratios: ReadonlyArray<[number, number]>, scaleRatio: number, tolerance: number) {
  const shift = step(scaleRatio);
  const limit = Math.log10(1 + tolerance) * STEPS_PER_DECADE + 0.5;
  let compared = 0;
  let agree = 0;
  for (const [s, n] of ratios) {
    compared += n;
    if (Math.abs(s + shift) <= limit) agree += n;
  }
  return { compared, agree };
}

/** The typical ratio a/b of two columns' amounts (the median of their log ratios), or null with no overlap. */
export function typicalRatio(ratios: ReadonlyArray<[number, number]>): number | null {
  return quantile({ read: 0, byConfidence: [], nonPositive: 0, histogram: [...ratios] }, 0.5);
}

/** The scale (one of SCALE_FACTORS) that brings a typical ratio source/standard closest to 1, when it is off by a power of 1,000. */
export function scaleFor(ratio: number | null): number | null {
  if (ratio === null || ratio <= 0) return null;
  const factor = SCALE_FACTORS.reduce((best, f) => (Math.abs(Math.log10(ratio * f)) < Math.abs(Math.log10(ratio * best)) ? f : best), 1 as number);
  return factor !== 1 && Math.abs(Math.log10(ratio * factor)) < 1 ? factor : null;
}

/** An amount in short form: 23.5M, 1.2K, 640. */
export const compactAmount = (amount: number) => new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(amount);

/** The power-of-ten band an amount falls in, for counting fills: "10M–100M". */
export function magnitudeBand(amount: number): string {
  if (!(amount > 0)) return "0 or less";
  const d = Math.floor(Math.log10(amount));
  return `${compactAmount(10 ** d)}–${compactAmount(10 ** (d + 1))}`;
}

/** An amount as written to a number column: whole for amounts of 1 or more unless the column keeps decimals. */
export function formatAmount(amount: number, decimals?: number): string {
  const places = decimals ?? (Math.abs(amount) >= 1 ? 0 : 2);
  return String(Number(amount.toFixed(places)));
}

/** Records two columns must share before their typical ratio suggests a scale. */
const MIN_SHARED = 2;

/**
 * Each source's typical amount over the standard's (or its counterpart's, on that object): the median ratio on records
 * holding both, or with fewer than MIN_SHARED such records the ratio of the two columns' medians. Null when either
 * side has no amounts.
 */
export function sourceRatio(profile: ObjectProfile, source: string, destination: string): { ratio: number; shared: number } | null {
  const pair = profile.pairs[pairKey(source, destination)];
  const ratios = (pair?.ratios ?? []).map(([s, n]) => [source < destination ? s : -s, n] as [number, number]);
  const shared = ratios.reduce((sum, [, n]) => sum + n, 0);
  if (shared >= MIN_SHARED) return { ratio: typicalRatio(ratios)!, shared };
  const a = profile.columns[source]?.quantity;
  const b = profile.columns[destination]?.quantity;
  const ma = a && quantile(a, 0.5);
  const mb = b && quantile(b, 0.5);
  return ma && mb ? { ratio: ma / mb, shared } : null;
}

/**
 * Scales for sources whose amounts sit a power of 1,000 away from the standard's: ZoomInfo's revenue in thousands
 * against HubSpot's in dollars gets ×1,000. Medians alone only suggest a scale when they differ by 300× or more.
 * Scales the user set are kept.
 */
export function suggestScales(args: {
  profiles: ReadonlyMap<string, ObjectProfile>;
  destinations: ReadonlyArray<Pick<Column, "object" | "name">>;
  sources: ReadonlyArray<Pick<Column, "key" | "object" | "name">>;
  scales: readonly ScaleEntry[];
}): ScaleEntry[] {
  const out: ScaleEntry[] = [];
  for (const source of args.sources) {
    if (args.scales.some((e) => e.column === source.key && e.origin === "user")) continue;
    const destination = args.destinations.find((d) => d.object === source.object);
    const profile = args.profiles.get(source.object);
    if (!destination || !profile) continue;
    const r = sourceRatio(profile, source.name, destination.name);
    if (!r || (r.shared < MIN_SHARED && Math.abs(Math.log10(r.ratio)) < 2.5)) continue;
    const factor = scaleFor(r.ratio);
    if (factor !== null) out.push({ column: source.key, factor, origin: "auto" });
  }
  return out;
}

// ── Profiling ────────────────────────────────────────────────────────────────

/** Most common values kept per column, and most common value combinations per column pair. */
export const TOP_VALUES = 300;
export const TOP_PAIRS = 150;
/** Columns profiled per object: with TOP_VALUES and TOP_PAIRS this keeps one object's profile well under 1 MB. */
export const MAX_COLUMNS_PER_OBJECT = 12;

/** Pairwise log-ratio steps kept per column pair, most common first. */
export const TOP_RATIOS = 120;

/** `quantity` is missing on profiles read before quantities were. */
export type ColumnProfile = { filled: number; distinct: number; values: Array<[string, number]>; quantity?: QuantityProfile };
/** `ratios`: where both columns read as positive amounts, their log ratio a/b (QuantityProfile steps) → count. */
export type PairProfile = { both: number; combos: Array<[string, string, number]>; ratios?: Array<[number, number]> };
/**
 * Which columns each record has filled, as a bitmask over `columns` (bit i), with bit `columns.length` set for a record
 * linked to Salesforce. The most common masks are kept; `other` counts the records whose mask was folded away.
 */
export type Signatures = { columns: string[]; masks: Array<[mask: number, count: number]>; other: number };
/** Distinct presence masks kept per object profile. */
export const MAX_SIGNATURES = 4000;
export type ObjectProfile = {
  object: ColumnObject;
  read: number;
  total: number | null;
  capped: boolean;
  /** HubSpot records Salesforce owns (HUBSPOT_SALESFORCE_LINK set). */
  linked: number;
  columns: Record<string, ColumnProfile>;
  /** Keyed `${a}|${b}` with a < b: how often two columns are both filled, and their most common value pairs. */
  pairs: Record<string, PairProfile>;
  /** Missing on profiles read before coverage was added. */
  signatures?: Signatures;
};

export const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

function top<T extends unknown[]>(entries: Iterable<[string, number]>, limit: number, unpack: (key: string, n: number) => T): T[] {
  return [...entries].sort((x, y) => y[1] - x[1]).slice(0, limit).map(([k, n]) => unpack(k, n));
}

/** Folds records one at a time into an object's profile: fill, value counts and pairwise value combinations. */
export class ProfileBuilder {
  private read = 0;
  private linked = 0;
  private readonly values = new Map<string, Map<string, number>>();
  private readonly both = new Map<string, number>();
  private readonly combos = new Map<string, Map<string, number>>();
  private readonly masks = new Map<number, number>();
  private readonly quantities = new Map<string, { byConfidence: Map<number, number>; nonPositive: number; histogram: Map<number, number> }>();
  private readonly ratios = new Map<string, Map<number, number>>();

  private readonly columns: readonly string[];

  constructor(columns: readonly string[]) {
    this.columns = columns;
    for (const c of columns) {
      this.values.set(c, new Map());
      this.quantities.set(c, { byConfidence: new Map(), nonPositive: 0, histogram: new Map() });
    }
  }

  add(record: Record<string, unknown>, linked = false) {
    this.read++;
    if (linked) this.linked++;
    const present: Array<[string, string, number | null]> = [];
    let mask = linked ? 2 ** this.columns.length : 0;
    for (const [i, c] of this.columns.entries()) {
      const value = cleanValue(record[c]);
      if (value === null) continue;
      mask += 2 ** i;
      const counts = this.values.get(c)!;
      counts.set(value, (counts.get(value) ?? 0) + 1);
      const q = parseQuantity(value);
      if (q) {
        const stats = this.quantities.get(c)!;
        stats.byConfidence.set(q.confidence, (stats.byConfidence.get(q.confidence) ?? 0) + 1);
        if (q.amount > 0) stats.histogram.set(step(q.amount), (stats.histogram.get(step(q.amount)) ?? 0) + 1);
        else stats.nonPositive++;
      }
      present.push([c, value, q && q.amount > 0 ? q.amount : null]);
    }
    for (let i = 0; i < present.length; i++) {
      for (let j = i + 1; j < present.length; j++) {
        const [[a, va, qa], [b, vb, qb]] = present[i]![0] < present[j]![0] ? [present[i]!, present[j]!] : [present[j]!, present[i]!];
        const key = `${a}|${b}`;
        this.both.set(key, (this.both.get(key) ?? 0) + 1);
        const combos = this.combos.get(key) ?? new Map<string, number>();
        const combo = `${va}\u0000${vb}`;
        combos.set(combo, (combos.get(combo) ?? 0) + 1);
        this.combos.set(key, combos);
        if (qa !== null && qb !== null) {
          const ratios = this.ratios.get(key) ?? new Map<number, number>();
          ratios.set(step(qa / qb), (ratios.get(step(qa / qb)) ?? 0) + 1);
          this.ratios.set(key, ratios);
        }
      }
    }
    this.masks.set(mask, (this.masks.get(mask) ?? 0) + 1);
  }

  result(object: ColumnObject, total: number | null, capped: boolean): ObjectProfile {
    const columns: Record<string, ColumnProfile> = {};
    for (const [c, counts] of this.values) {
      let filled = 0;
      for (const n of counts.values()) filled += n;
      const q = this.quantities.get(c)!;
      const read = [...q.byConfidence.values()].reduce((s, n) => s + n, 0);
      columns[c] = {
        filled, distinct: counts.size, values: top(counts, TOP_VALUES, (k, n) => [k, n] as [string, number]),
        ...(read ? { quantity: { read, byConfidence: [...q.byConfidence], nonPositive: q.nonPositive, histogram: [...q.histogram] } } : {}),
      };
    }
    const pairs: Record<string, PairProfile> = {};
    for (const [key, n] of this.both) {
      pairs[key] = {
        both: n,
        combos: top(this.combos.get(key)!, TOP_PAIRS, (k, count) => {
          const [a, b] = k.split("\u0000");
          return [a!, b!, count] as [string, string, number];
        }),
        ...(this.ratios.has(key) ? { ratios: [...this.ratios.get(key)!].sort((x, y) => y[1] - x[1]).slice(0, TOP_RATIOS) } : {}),
      };
    }
    const masks = [...this.masks].sort((a, b) => b[1] - a[1]);
    const kept = masks.slice(0, MAX_SIGNATURES);
    const other = masks.slice(MAX_SIGNATURES).reduce((sum, [, n]) => sum + n, 0);
    return { object, read: this.read, total, capped, linked: this.linked, columns, pairs, signatures: { columns: [...this.columns], masks: kept, other } };
  }
}

// ── Mapping ──────────────────────────────────────────────────────────────────

export type MapOrigin = "auto" | "ai" | "user";
/** Source value (by mapKey) → a target option value, or null for "leave unmapped". */
export type MapEntry = { from: string; to: string | null; origin: MapOrigin; confidence: number };
/** A map grows with free-text sources; past this many distinct values the rest stay unmapped. */
export const MAX_MAP_ENTRIES = 2000;

/** Catch-all options ("Other", "Unknown"): mapping into them hides the real value, so the page asks to cut them down. */
export function isCatchAll(option: ColumnOption): boolean {
  return /\b(other|others|misc|miscellaneous|unknown|n ?a|none|general|unclassified)\b/.test(mapKey(`${option.label} ${option.value}`));
}

/** The target option a value names itself (by internal value or label), regardless of case and punctuation. */
export function optionFor(value: string, options: readonly ColumnOption[]): ColumnOption | null {
  const key = mapKey(value);
  return options.find((o) => o.value === value) ?? options.find((o) => mapKey(o.value) === key || mapKey(o.label) === key) ?? null;
}

/** Deterministic suggestions: a source value that names a target option is mapped to it with full confidence. */
export function autoMap(sourceValues: Iterable<string>, options: readonly ColumnOption[]): MapEntry[] {
  const out = new Map<string, MapEntry>();
  for (const value of sourceValues) {
    const from = mapKey(value);
    if (!from || out.has(from)) continue;
    const option = optionFor(value, options);
    if (option) out.set(from, { from, to: option.value, origin: "auto", confidence: 1 });
  }
  return [...out.values()];
}

export type Resolution = { to: string; confidence: number; origin: MapOrigin | "self" };

/** What a source value means in the target column: the map's entry first, else the option it names. */
export function resolveValue(value: string, map: ReadonlyMap<string, MapEntry>, options: readonly ColumnOption[]): Resolution | null {
  const entry = map.get(mapKey(value));
  // An entry made for another standard column (the target changed since) names no option here and is ignored.
  if (entry) return entry.to === null || !options.some((o) => o.value === entry.to) ? null : { to: entry.to, confidence: entry.confidence, origin: entry.origin };
  const option = optionFor(value, options);
  return option ? { to: option.value, confidence: 1, origin: "self" } : null;
}

export const mapOf = (entries: readonly MapEntry[]) => new Map(entries.map((e) => [e.from, e]));

// ── Coverage ─────────────────────────────────────────────────────────────────

/** The share of a column's filled records (by its most common values) whose value maps to an option confidently enough. */
export function mappedShare(values: ReadonlyArray<[string, number]>, map: ReadonlyMap<string, MapEntry>, options: readonly ColumnOption[], minConfidence: number): number {
  let all = 0;
  let mapped = 0;
  for (const [value, n] of values) {
    all += n;
    if ((resolveValue(value, map, options)?.confidence ?? -1) >= minConfidence) mapped += n;
  }
  return all ? mapped / all : 0;
}

export type Waterfall = { total: number; alreadySet: number; owned: number; bySource: Array<{ key: string; adds: number }>; blank: number; exact: false };

/**
 * Expected coverage of a destination column from the profile's presence signatures: what each source adds after the
 * ones above it, assuming a source's value maps as often on any record as across its filled records. Expected values,
 * not counts: they are fractional until rounded for display.
 */
export function coverageWaterfall(args: {
  profile: ObjectProfile;
  target: string;
  sources: readonly string[];
  share: (sourceKey: string) => number;
  mode: Policy["mode"];
}): Waterfall {
  const { profile, mode } = args;
  const sig = profile.signatures ?? { columns: [], masks: [], other: 0 };
  const bit = (key: string) => {
    const i = sig.columns.indexOf(parseColumnKey(key).name);
    return i < 0 ? 0 : 2 ** i;
  };
  const has = (mask: number, b: number) => b > 0 && Math.floor(mask / b) % 2 === 1;
  const linkedBit = 2 ** sig.columns.length;
  const hubspot = profile.object === "companies" || profile.object === "contacts";
  const targetBit = bit(args.target);
  const sources = args.sources.map((key) => ({ key, bit: bit(key), share: Math.max(0, Math.min(1, args.share(key))), adds: 0 }));
  let total = sig.other;
  let alreadySet = 0;
  let owned = 0;
  let blank = sig.other;
  for (const [mask, count] of sig.masks) {
    total += count;
    if (hubspot && has(mask, linkedBit)) {
      owned += count;
      continue;
    }
    const present = has(mask, targetBit);
    if (mode === "blanks" && present) {
      alreadySet += count;
      continue;
    }
    let remaining = count;
    for (const s of sources) {
      if (!has(mask, s.bit)) continue;
      const adds = remaining * s.share;
      s.adds += adds;
      remaining -= adds;
    }
    if (present) alreadySet += remaining;
    else blank += remaining;
  }
  return { total, alreadySet, owned, bySource: sources.map((s) => ({ key: s.key, adds: s.adds })), blank, exact: false };
}

/**
 * How often two columns agree where both are filled, after mapping both into the target's values. Computed over the
 * most common combinations the profile kept; `covered` says how many of the `both` records that is.
 */
export function agreement(pair: PairProfile, aIsFirst: boolean, toTarget: (column: "a" | "b", value: string) => string | null) {
  let compared = 0;
  let agree = 0;
  let covered = 0;
  for (const [x, y, n] of pair.combos) {
    covered += n;
    const [va, vb] = aIsFirst ? [x, y] : [y, x];
    const ta = toTarget("a", va);
    const tb = toTarget("b", vb);
    if (ta === null || tb === null) continue;
    compared += n;
    if (ta === tb) agree += n;
  }
  return { both: pair.both, covered, compared, agree };
}

// ── Picklist parity ──────────────────────────────────────────────────────────

export type ParityRow = { target: ColumnOption; mirror: ColumnOption | null; status: "same" | "valueDiffers" | "missing" };

/**
 * The standard column's options against its synced counterpart's. HubSpot writes and score rules use the internal
 * value, so an option whose label matches under another internal value is called out, not treated as the same.
 */
export function picklistParity(target: readonly ColumnOption[], mirror: readonly ColumnOption[]) {
  const rows: ParityRow[] = target.map((t) => {
    const same = mirror.find((m) => m.value === t.value);
    if (same) return { target: t, mirror: same, status: "same" as const };
    const byLabel = mirror.find((m) => mapKey(m.label) === mapKey(t.label) || mapKey(m.value) === mapKey(t.value));
    return byLabel ? { target: t, mirror: byLabel, status: "valueDiffers" as const } : { target: t, mirror: null, status: "missing" as const };
  });
  const matched = new Set(rows.map((r) => r.mirror?.value).filter(Boolean));
  return { rows, mirrorOnly: mirror.filter((m) => !matched.has(m.value)) };
}

/** A target value in the counterpart's own internal value, or null when the counterpart has no such option. */
export function translateOption(value: string, target: readonly ColumnOption[], mirror: readonly ColumnOption[]): string | null {
  const t = target.find((o) => o.value === value);
  const row = t ? picklistParity([t], mirror).rows[0]! : null;
  return row?.mirror?.value ?? null;
}

// ── Decisions ────────────────────────────────────────────────────────────────

export type Policy = {
  /** Fill blanks only, or also change values the sources disagree with. */
  mode: "blanks" | "overwrite";
  /** Target values never changed (e.g. "Platform Partner"). */
  protectedValues: string[];
  /** Mappings (for a quantity, readings of a value as an amount) below this confidence are not used. */
  minConfidence: number;
  /** Quantity only: how the sources' amounts make one value. Unset is "first". */
  combine?: Combine;
  /** Quantity only: a current value within this share of the proposed one agrees with it. Unset is DEFAULT_TOLERANCE. */
  tolerance?: number;
};

export const DEFAULT_POLICY: Policy = { mode: "blanks", protectedValues: [], minConfidence: 0.9 };
export const DEFAULT_TOLERANCE = 0.1;

/** `amount`: a quantity candidate's value in the standard's units, after its column's scale. */
export type Candidate = { column: string; raw: string; value: string | null; confidence: number; missingOption?: boolean; amount?: number; source?: string };
export type DecisionKind = "fill" | "change" | "agree" | "kept" | "protected" | "noSource" | "missingOption" | "salesforceOwned";
export type Decision = { kind: DecisionKind; current: string | null; proposed: string | null; evidence: Candidate | null };

/**
 * A record's sources as candidates, in priority order: each filled source value mapped into the target's options,
 * then into the written column's own value (`inColumn`; null when that column has no such option). The evidence names
 * the source column by its label.
 */
export function candidatesFor(
  values: Record<string, string | null>,
  sources: ReadonlyArray<Pick<Column, "name" | "label"> & { key?: string }>,
  map: ReadonlyMap<string, MapEntry>,
  options: readonly ColumnOption[],
  inColumn: (value: string) => string | null = (value) => value,
): Candidate[] {
  const out: Candidate[] = [];
  for (const source of sources) {
    const raw = cleanValue(values[source.name]);
    if (raw === null) continue;
    const resolved = resolveValue(raw, map, options);
    if (!resolved) continue;
    const value = inColumn(resolved.to);
    out.push({ column: source.label, raw, value, confidence: resolved.confidence, ...(value === null ? { missingOption: true } : {}), ...(source.key ? { source: source.key } : {}) });
  }
  return out;
}

/**
 * A record's sources as amounts in the standard's units, in priority order: each filled source value read as an amount
 * and multiplied by its column's scale. `value` is the amount as it would be written.
 */
export function quantityCandidates(
  values: Record<string, string | null>,
  sources: ReadonlyArray<Pick<Column, "key" | "name" | "label">>,
  scales: readonly ScaleEntry[],
  decimals?: number,
): Candidate[] {
  const out: Candidate[] = [];
  for (const source of sources) {
    const raw = cleanValue(values[source.name]);
    const q = raw === null ? null : parseQuantity(raw);
    if (!q) continue;
    const amount = q.amount * scaleOf(scales, source.key);
    out.push({ column: source.label, raw: raw!, value: formatAmount(amount, decimals), confidence: q.confidence, amount, source: source.key });
  }
  return out;
}

/**
 * The value the usable candidates make by the policy's method, and the candidate that stands as its evidence: the one
 * chosen, or for an average or median the first by priority with every source's value in `raw`.
 */
function combined(usable: readonly Candidate[], method: Combine, decimals?: number): { value: string; evidence: Candidate } {
  const amounts = usable.map((c) => c.amount!);
  if (method === "first" || usable.length === 1) return { value: usable[0]!.value!, evidence: usable[0]! };
  if (method === "min" || method === "max") {
    const pick = usable.reduce((best, c) => ((method === "min" ? c.amount! < best.amount! : c.amount! > best.amount!) ? c : best));
    return { value: pick.value!, evidence: pick };
  }
  const sorted = [...amounts].sort((a, b) => a - b);
  const mid = sorted.length / 2;
  const amount = method === "mean" ? amounts.reduce((s, a) => s + a, 0) / amounts.length : sorted.length % 2 ? sorted[Math.floor(mid)]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
  const raw = usable.map((c) => `${c.column}: ${c.raw}`).join("; ");
  return { value: formatAmount(amount, decimals), evidence: { ...usable[0]!, raw, confidence: Math.min(...usable.map((c) => c.confidence)) } };
}

/** Whether a current amount agrees with a proposed one: equal within the tolerance, relative to the larger. */
export function sameAmount(current: string, proposed: string, tolerance: number): boolean {
  const a = parseQuantity(current)?.amount;
  const b = Number(proposed);
  if (a === undefined) return false;
  return Math.abs(a - b) <= tolerance * Math.max(Math.abs(a), Math.abs(b));
}

/**
 * What one record gets. A category takes the first source, in priority order, that maps with enough confidence; a
 * quantity combines the sources read with enough confidence by the policy's method and agrees within its tolerance.
 * A protected current value is never touched, and in blanks mode a filled value is kept.
 */
export function decide(current: string | null, candidates: readonly Candidate[], policy: Policy, measure: Measure = "category", decimals?: number): Decision {
  const now = cleanValue(current);
  if (now !== null && policy.protectedValues.includes(now)) return { kind: "protected", current: now, proposed: null, evidence: null };
  if (measure === "quantity") {
    const usable = candidates.filter((c) => c.amount !== undefined && c.confidence >= policy.minConfidence);
    if (!usable.length) return { kind: "noSource", current: now, proposed: null, evidence: null };
    const { value, evidence } = combined(usable, policy.combine ?? "first", decimals);
    if (now !== null && sameAmount(now, value, policy.tolerance ?? DEFAULT_TOLERANCE)) return { kind: "agree", current: now, proposed: value, evidence };
    if (now === null) return { kind: "fill", current: now, proposed: value, evidence };
    return { kind: policy.mode === "blanks" ? "kept" : "change", current: now, proposed: value, evidence };
  }
  const pick = candidates.find((c) => c.value !== null && c.confidence >= policy.minConfidence) ?? null;
  if (!pick) {
    const missing = candidates.find((c) => c.missingOption && c.confidence >= policy.minConfidence) ?? null;
    return { kind: missing ? "missingOption" : "noSource", current: now, proposed: null, evidence: missing };
  }
  if (now === pick.value) return { kind: "agree", current: now, proposed: pick.value, evidence: pick };
  if (now === null) return { kind: "fill", current: now, proposed: pick.value, evidence: pick };
  return { kind: policy.mode === "blanks" ? "kept" : "change", current: now, proposed: pick.value, evidence: pick };
}

// ── The field above the CRMs ─────────────────────────────────────────────────

/**
 * A Canon field is defined above every CRM (docs/canon-fields-above-the-crm.md): a category with its own options or
 * a quantity, on companies or on people. Its sources are columns of that level in any connected CRM, and it writes
 * any number of destination columns, each in its own mode.
 */
export type FieldDefinition = { measure: Measure; level: ColumnLevel; options: ColumnOption[] };
export type DestinationMode = "off" | "shadow" | "review" | "auto";
export type Destination = { column: string; mode: DestinationMode };

export const DESTINATION_MODE_LABEL: Record<DestinationMode, string> = {
  off: "Off",
  shadow: "Shadow",
  review: "Review",
  auto: "Auto",
};

type FieldDoc = {
  kind?: Measure;
  level?: ColumnLevel;
  options?: ColumnOption[];
  target?: string;
  mirror?: string;
  destinations?: Destination[];
};

/** The field's definition: saved, or for a field set up before destinations, its standard column's. Null until defined. */
export function fieldDefinition(doc: FieldDoc, columns: readonly Column[]): FieldDefinition | null {
  if (doc.kind && doc.level) return { measure: doc.kind, level: doc.level, options: doc.kind === "category" ? (doc.options ?? []) : [] };
  const target = doc.target ? columns.find((c) => c.key === doc.target) : undefined;
  if (!target) return null;
  return { measure: measureOf(target), level: COLUMN_OBJECTS[target.object].level, options: measureOf(target) === "category" ? target.options : [] };
}

/** The columns the field writes: saved, or for a field set up before destinations, its standard and counterpart. */
export function destinationsOf(doc: FieldDoc): Destination[] {
  if (doc.destinations) return doc.destinations;
  return [doc.target, doc.mirror].filter((k): k is string => Boolean(k)).map((column) => ({ column, mode: "review" as const }));
}

/** Whether a column can be one of the field's destinations: a writable CRM column of its kind on records of its level. */
export function destinationFits(column: Column, field: FieldDefinition): boolean {
  return (
    !column.enrichment && !column.readOnly && writableColumn(column) && COLUMN_OBJECTS[column.object].level === field.level &&
    (field.measure === "quantity" ? column.kind === "number" : column.kind === "picklist")
  );
}

/** Whether a column can be one of the field's sources: any column on records of its level, in any CRM or enrichment. */
export const sourceFits = (column: Column, field: FieldDefinition) => COLUMN_OBJECTS[column.object].level === field.level;

/** A record read from one CRM object, with the columns a run needs. */
export type CrmRecord = { object: ColumnObject; id: string; values: Record<string, string | null> };

const SALESFORCE_LINK_OBJECT: Record<string, ColumnObject> = { salesforceaccountid: "Account", salesforcecontactid: "Contact", salesforceleadid: "Lead" };
/** Salesforce ids compare on their case-sensitive 15-character form; APIs and HubSpot may hold the 18-character one. */
const recordKey = (object: ColumnObject, id: string) => `${object}:${COLUMN_OBJECTS[object].system === "salesforce" ? id.slice(0, 15) : id}`;

/**
 * Records grouped into Canon records: the CRM records that describe one company or one person. HubSpot's Salesforce
 * integration links a company to its Account and a contact to its Contact or Lead (HUBSPOT_SALESFORCE_LINK); linked
 * records join, and so does everything linked to the same record. A record linked to nothing stands alone.
 */
export function canonRecords(records: readonly CrmRecord[]): CrmRecord[][] {
  const parent = new Map<string, string>();
  const find = (k: string): string => {
    let root = k;
    while (parent.get(root) !== root) root = parent.get(root)!;
    for (let at = k; at !== root; ) {
      const next = parent.get(at)!;
      parent.set(at, root);
      at = next;
    }
    return root;
  };
  for (const r of records) parent.set(recordKey(r.object, r.id), recordKey(r.object, r.id));
  const union = (a: string, b: string) => {
    if (!parent.has(b)) parent.set(b, b);
    parent.set(find(a), find(b));
  };
  for (const r of records) {
    for (const property of HUBSPOT_SALESFORCE_LINK[r.object] ?? []) {
      const linked = cleanValue(r.values[property]);
      if (linked) union(recordKey(r.object, r.id), recordKey(SALESFORCE_LINK_OBJECT[property]!, linked));
    }
  }
  const groups = new Map<string, CrmRecord[]>();
  for (const r of records) {
    const root = find(recordKey(r.object, r.id));
    const group = groups.get(root);
    if (group) group.push(r);
    else groups.set(root, [r]);
  }
  return [...groups.values()];
}

const CANON_DECIMALS = 6;

/** The Canon value of one Canon record, in the field's own terms: an option's value or an amount, with its evidence. */
export type CanonValue = { value: string; amount?: number; evidence: Candidate } | null;

/**
 * One Canon record's value from its sources, wherever they live, in priority order. Each source column is read from
 * the first record in the group that has it filled. A category takes the first source that maps to one of the field's
 * options with enough confidence; a quantity combines the amounts read with enough confidence by the policy's method.
 */
export function canonValue(
  group: readonly CrmRecord[],
  sources: readonly Column[],
  field: FieldDefinition,
  map: ReadonlyMap<string, MapEntry>,
  scales: readonly ScaleEntry[],
  policy: Policy,
): CanonValue {
  const values: Record<string, string | null> = {};
  for (const source of sources) {
    values[source.key] = group.find((r) => r.object === source.object && cleanValue(r.values[source.name]) !== null)?.values[source.name] ?? null;
  }
  // Read by key, since two CRMs can name a column alike; the evidence names it with its record type.
  const byKey = sources.map((s) => ({ ...s, name: s.key, label: s.enrichment ? s.label : `${s.label} (${COLUMN_OBJECTS[s.object].label})` }));
  const open: Policy = { ...policy, mode: "overwrite", protectedValues: [] };
  if (field.measure === "quantity") {
    // Kept to six places: each destination rounds it to its own precision.
    const decision = decide(null, quantityCandidates(values, byKey, scales, CANON_DECIMALS), open, "quantity", CANON_DECIMALS);
    if (!decision.proposed || !decision.evidence) return null;
    return { value: decision.proposed, amount: Number(decision.proposed), evidence: decision.evidence };
  }
  const decision = decide(null, candidatesFor(values, byKey, map, field.options), open, "category");
  return decision.proposed && decision.evidence ? { value: decision.proposed, evidence: decision.evidence } : null;
}

/**
 * Canon's own attributes a field takes over when it is about the same thing: by the field's name, or by a destination
 * (or the column it was defined from) being one of the CRM columns the sync reads into that attribute.
 */
const STANDARD_ATTRIBUTES: ReadonlyArray<{ level: ColumnLevel; attribute: string; measure: Measure; names: readonly string[]; columns: readonly string[] }> = [
  { level: "account", attribute: "industry", measure: "category", names: ["industry"], columns: ["companies.industry", "Account.Industry"] },
  { level: "account", attribute: "annualRevenue", measure: "quantity", names: ["revenue", "annual revenue"], columns: ["companies.annualrevenue", "Account.AnnualRevenue"] },
  { level: "account", attribute: "employees", measure: "quantity", names: ["employees", "headcount", "employee count", "number of employees"], columns: ["companies.numberofemployees", "Account.NumberOfEmployees"] },
  { level: "account", attribute: "country", measure: "category", names: ["country"], columns: ["companies.country", "Account.BillingCountry"] },
  { level: "person", attribute: "title", measure: "category", names: ["title", "job title"], columns: ["contacts.jobtitle", "Contact.Title", "Lead.Title"] },
];

/** A custom attribute's slug from the field's name (`custom.<slug>`, lib/objects/registry.ts CUSTOM_FIELD_API_NAME). */
const customAttribute = (concept: string) => `custom.${(mapKey(concept).replace(/[^a-z0-9]+/g, "_").replace(/^[^a-z]+|_+$/g, "") || "field").slice(0, 63)}`;

/**
 * The Canon attribute a field's values are stored in: a standard one it takes over (industry, annual revenue, ...)
 * when it is about the same thing on the same records, otherwise its own `custom.<name>`.
 */
export function canonAttribute(concept: string, field: FieldDefinition, columns: readonly string[]): string {
  const name = mapKey(concept);
  const standard = STANDARD_ATTRIBUTES.find((s) => s.level === field.level && s.measure === field.measure && (s.names.includes(name) || columns.some((c) => s.columns.includes(c))));
  return standard?.attribute ?? customAttribute(concept);
}

/**
 * A Canon value as the attribute stores it: a category's option label (Canon's standard text attributes hold words,
 * not a CRM's internal values), an amount as a number, annual revenue in cents as the CRM mirror keeps it.
 */
export function canonFactValue(value: NonNullable<CanonValue>, field: FieldDefinition, attribute: string): string | number {
  if (field.measure === "quantity") return attribute === "annualRevenue" ? Math.round(value.amount! * 100) : value.amount!;
  return field.options.find((o) => o.value === value.value)?.label ?? value.value;
}

/** A field option's value in a destination column's own values; null when the column has no such option. */
export const inDestination = (value: string, field: FieldDefinition, column: Pick<Column, "options">) => translateOption(value, field.options, column.options);

/**
 * What one destination record gets from its Canon record's value: the value in the column's own terms, then the
 * policy against the record's current value (protected values are in the field's terms too).
 */
export function decideDestination(current: string | null, canon: CanonValue, field: FieldDefinition, column: Column, policy: Policy): Decision {
  if (field.measure === "quantity") {
    const candidates = canon ? [{ ...canon.evidence, value: formatAmount(canon.amount!, column.decimals), amount: canon.amount! }] : [];
    return decide(current, candidates, { ...policy, combine: "first" }, "quantity", column.decimals);
  }
  const protectedValues = policy.protectedValues.map((p) => inDestination(p, field, column)).filter((p): p is string => p !== null);
  if (!canon) return decide(current, [], { ...policy, protectedValues });
  const value = inDestination(canon.value, field, column);
  return decide(current, [{ ...canon.evidence, value, ...(value === null ? { missingOption: true } : {}) }], { ...policy, protectedValues });
}

export const DECISION_LABEL: Record<DecisionKind, string> = {
  fill: "Fill a blank",
  change: "Change a value",
  agree: "Already agrees",
  kept: "Kept (blanks only)",
  protected: "Protected value",
  noSource: "No mapped source",
  missingOption: "Option missing in this system",
  salesforceOwned: "Owned by Salesforce",
};

/** RFC 4180 CSV: quote every cell that needs it. */
export function toCsv(header: readonly string[], rows: ReadonlyArray<ReadonlyArray<string | number | null>>): string {
  const cell = (v: string | number | null) => {
    const s = v === null ? "" : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [header, ...rows].map((r) => r.map(cell).join(",")).join("\r\n");
}

// ── Status ───────────────────────────────────────────────────────────────────

export type RunOutcome = { applied: number; conflict: number; failed: number };

export type ConsolidationStatus =
  | { state: "findingColumns" }
  | { state: "chooseStandard" }
  /** `changedSince` is the date of a preview the settings changed after, which can no longer be applied. */
  | { state: "readyToPreview"; changedSince: number | null }
  | { state: "previewing" }
  | { state: "readyToApply"; previewedAt: number; fill: number; change: number; writes: number }
  | { state: "applying"; writes: number }
  | { state: "applied"; at: number; outcome: RunOutcome }
  | { state: "undoing" }
  | { state: "undone"; at: number; outcome: RunOutcome }
  | { state: "stopped"; during: "columns" | "preview" | "apply" | "undo"; error: string | null };

type StatusRun = {
  status: "previewing" | "ready" | "applying" | "applied" | "undoing" | "undone" | "failed";
  settingsVersion: number;
  writes: number;
  createdAt: number;
  updatedAt: number;
  appliedAt?: number;
  undoneAt?: number;
  applied?: RunOutcome;
  undone?: RunOutcome;
  failedDuring?: "preview" | "apply" | "undo";
  error?: string;
  sections?: unknown;
};

/**
 * Where a consolidation stands, from its setup and its latest run. A run that is writing comes first, since the CRM
 * is going through it; then a stopped column read, then the first step still missing.
 */
export function consolidationStatus(
  doc: { stage: "discovering" | "profiling" | "ready" | "error"; error?: string; target?: string; kind?: Measure; level?: ColumnLevel; settingsVersion?: number },
  run: StatusRun | null,
): ConsolidationStatus {
  if (run?.status === "applying") return { state: "applying", writes: run.writes };
  if (run?.status === "undoing") return { state: "undoing" };
  if (doc.stage === "error") return { state: "stopped", during: "columns", error: doc.error ?? null };
  if (doc.stage === "discovering" || doc.stage === "profiling") return { state: "findingColumns" };
  if (!doc.target && !(doc.kind && doc.level)) return { state: "chooseStandard" };
  if (!run) return { state: "readyToPreview", changedSince: null };
  const none = { applied: 0, conflict: 0, failed: 0 };
  switch (run.status) {
    case "previewing":
      return { state: "previewing" };
    case "failed":
      return { state: "stopped", during: run.failedDuring ?? "preview", error: run.error ?? null };
    case "applied":
      return { state: "applied", at: run.appliedAt ?? run.updatedAt, outcome: run.applied ?? none };
    case "undone":
      return { state: "undone", at: run.undoneAt ?? run.updatedAt, outcome: run.undone ?? none };
    default: {
      if (run.settingsVersion !== (doc.settingsVersion ?? 0)) return { state: "readyToPreview", changedSince: run.createdAt };
      // Shadow destinations show their differences but are never written.
      const sections = (Array.isArray(run.sections) ? (run.sections as Array<{ mode?: DestinationMode; counts?: Partial<Record<DecisionKind, number>> }>) : []).filter((x) => x.mode !== "shadow");
      const sum = (kind: DecisionKind) => sections.reduce((s, x) => s + (x.counts?.[kind] ?? 0), 0);
      return { state: "readyToApply", previewedAt: run.createdAt, fill: sum("fill"), change: sum("change"), writes: run.writes };
    }
  }
}
