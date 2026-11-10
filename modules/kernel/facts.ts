/**
 * Canon's fact ledger as a module reads and proposes to it (docs/modules.md, "Facts"): each attribute's resolved value,
 * its state, when its winning fact was last confirmed, and optionally the facts behind it; and the facts a module
 * proposes, each with its evidence, for a person to review. Pure: the manifest checks a module's grant with it, and
 * Canon plans `facts.forRecords` and checks a `facts.propose` with it.
 */

/** The records a module reads facts about, by the names `reads` uses. */
export const FACT_OBJECTS = ["deals", "companies", "people"] as const;
export type FactObject = (typeof FACT_OBJECTS)[number];
export type FactValue = string | number | boolean | null;
/** `unknown`: a `custom.<slug>` the workspace has no field for, which no fact can fill (`empty` is a field with no value yet). */
export type FieldState = "resolved" | "contested" | "empty" | "unknown";
export type FactStatus = "proposed" | "accepted" | "rejected" | "superseded";

/** One fact behind a field: what it says, where it came from, its evidence and where review left it. */
export type FactReceipt = {
  id: string;
  value: FactValue;
  status: FactStatus;
  /**
   * `kind` is a label (`salesforce`, `agent_run`, `user`), not a closed list. `actor` is `<kind>:<id>`, as `user:<member id>`.
   * `module` is the id of the module that proposed it, for a fact a module proposed.
   */
  source: { kind: string; actor: string; module?: string };
  /** The proposal it came in, for a fact a module proposed: the id `facts.propose` stamps and `proposals.byIds` reads. */
  proposal?: string;
  evidence: string | null;
  confidence: number;
  observedAt: number;
  validFrom: number | null;
  lastConfirmedAt?: number;
  validTo?: number | null;
  decidedAt: number | null;
};

export type ResolvedField = {
  attribute: string;
  value: FactValue;
  state: FieldState;
  /** The winning fact's id, or null when the field has none. */
  winner: string | null;
  /** The facts that disagree with the winner, when the field is contested. */
  contestedBy?: string[];
  /** When the winning fact was last confirmed (ms). */
  confirmedAt?: number;
};

export type FactsForRecordsArgs = { object: FactObject; ids: string[]; attributes?: string[]; receipts?: number };
export type FactsForRecordsRow = { id: string; fields: ResolvedField[]; receipts?: Record<string, FactReceipt[]> };

/**
 * The attributes a module may read facts of, and propose facts for, by object (`facts.<object>.read` and
 * `facts.<object>.propose` in its manifest): the install screen lists them.
 */
export type FactsDecl = Partial<Record<FactObject, { read?: readonly string[]; propose?: readonly string[] }>>;

/**
 * What a standard attribute's value is: text, a number, money (an integer in minor units: cents for USD), a date (`YYYY-MM-DD`), true or false, a choice (one option's key), a member's or a
 * CRM user's id, or credit splits (several values, which `facts.forRecords` doesn't read).
 */
export type FactKind = "text" | "number" | "money" | "date" | "boolean" | "choice" | "user" | "splits";
export type FactAttributeDecl = { readonly name: string; readonly kind: FactKind };

/**
 * The standard attributes Canon's fact ledger tracks, per object: the one list a manifest's `facts` grant is checked
 * against and the ledger itself uses (convex/lib/canon/attributes.ts). A company or person also has its workspace's
 * own, `custom.<slug>`, which only the workspace knows.
 */
export const FACT_ATTRIBUTES = {
  companies: [
    { name: "name", kind: "text" }, { name: "domain", kind: "text" }, { name: "industry", kind: "text" }, { name: "employees", kind: "number" },
    { name: "annualRevenue", kind: "money" }, { name: "country", kind: "text" }, { name: "linkedinUrl", kind: "text" }, { name: "ownerId", kind: "user" },
  ],
  people: [
    { name: "fullName", kind: "text" }, { name: "title", kind: "text" }, { name: "email", kind: "text" }, { name: "phone", kind: "text" },
    { name: "linkedinUrl", kind: "text" }, { name: "ownerId", kind: "user" },
  ],
  deals: [
    { name: "name", kind: "text" }, { name: "amount", kind: "money" }, { name: "currency", kind: "text" }, { name: "closeDate", kind: "date" },
    { name: "stage", kind: "choice" }, { name: "forecastCategory", kind: "choice" }, { name: "probability", kind: "number" },
    { name: "isClosed", kind: "boolean" }, { name: "isWon", kind: "boolean" }, { name: "crmOwnerId", kind: "user" }, { name: "dealType", kind: "choice" },
    { name: "nextStep", kind: "text" }, { name: "splitAllocations", kind: "splits" },
  ],
} as const satisfies Record<FactObject, readonly FactAttributeDecl[]>;
export type StandardFactAttribute<O extends FactObject> = (typeof FACT_ATTRIBUTES)[O][number]["name"];
/** An object's standard attribute names, in the ledger's order. */
export const standardFactAttributes = <O extends FactObject>(object: O): ReadonlyArray<StandardFactAttribute<O>> =>
  FACT_ATTRIBUTES[object].map((a) => a.name) as ReadonlyArray<StandardFactAttribute<O>>;
const isCustomAttribute = (attribute: string) => attribute.startsWith("custom.");

export const FACTS_MAX_IDS = 100;
export const FACTS_MAX_RECEIPTS = 20;
/** The most attributes a module declares per object, so one read stays inside a query's limits. */
export const FACTS_MAX_ATTRIBUTES = 20;
/** A core attribute (`industry`, `closeDate`) or an org's own (`custom.<slug>`, companies and people only). */
export const FACT_ATTRIBUTE = /^(?:[a-z][A-Za-z0-9]{0,62}|custom\.[a-z][a-z0-9_]{0,62})$/;

/**
 * What is wrong with a module's `facts` grant, beyond its shape: every name it gives is a standard attribute of its
 * object or a `custom.<slug>` (companies and people: deals have none), and a grant names something. A custom one is
 * the workspace's, so only a read or proposal can say it doesn't exist there.
 */
export function factsDeclProblems(decl: FactsDecl | undefined): string[] {
  const unknown = FACT_OBJECTS.flatMap((o) => (["read", "propose"] as const).flatMap((k) => (decl?.[o]?.[k] ?? []).flatMap((a) => {
    if (isCustomAttribute(a)) return o === "deals" ? [`facts.deals.${k} names ${a}: deals have no custom. attributes`] : [];
    return (standardFactAttributes(o) as readonly string[]).includes(a) ? [] : [`facts.${o}.${k} names ${a}, which isn't an attribute of ${o} (${standardFactAttributes(o).join(", ")}, or custom.<slug>${o === "deals" ? " on companies and people" : ""})`];
  })));
  const empty = FACT_OBJECTS.filter((o) => decl?.[o] && !decl[o]!.read && !decl[o]!.propose).map((o) => `facts.${o} needs read or propose`);
  return [...unknown, ...empty];
}

export type FactsReadPlan = { object: FactObject; ids: string[]; attributes: string[]; receipts: number };

/**
 * A `facts.forRecords` read's arguments, checked against the module's grant: its object and every attribute it names
 * must be declared, at most 100 ids and 20 receipts per attribute. Without `attributes`, every declared one. A problem
 * refuses the read: an undeclared attribute is never left out quietly.
 */
export function planFactsRead(decl: FactsDecl | undefined, args: Record<string, unknown>): FactsReadPlan | { problem: string } {
  const object = args.object;
  if (typeof object !== "string" || !(FACT_OBJECTS as readonly string[]).includes(object)) return { problem: `facts.forRecords reads facts of ${FACT_OBJECTS.join(", ")}.` };
  const declared = decl?.[object as FactObject]?.read;
  if (!declared) return { problem: `This module doesn't declare facts.${object}.read.` };
  if (!Array.isArray(args.ids) || !args.ids.every((id) => typeof id === "string")) return { problem: "facts.forRecords needs ids as a list of record ids." };
  const ids = [...new Set(args.ids as string[])];
  if (ids.length > FACTS_MAX_IDS) return { problem: `facts.forRecords reads at most ${FACTS_MAX_IDS} records.` };
  const asked = args.attributes ?? null;
  if (asked !== null && (!Array.isArray(asked) || !asked.every((a) => typeof a === "string"))) return { problem: "facts.forRecords needs attributes as a list of names." };
  const undeclared = (asked ?? []).filter((a) => !declared.includes(a));
  if (undeclared.length) return { problem: `This module doesn't declare facts.${object} ${undeclared.join(", ")}.` };
  const receipts = args.receipts ?? 0;
  if (typeof receipts !== "number" || !Number.isInteger(receipts) || receipts < 0 || receipts > FACTS_MAX_RECEIPTS) return { problem: `facts.forRecords reads 0 to ${FACTS_MAX_RECEIPTS} receipts per attribute.` };
  return { object: object as FactObject, ids, attributes: asked ? [...new Set(asked)] : [...declared], receipts };
}

/**
 * One fact a module proposes (`facts.propose`): the record by its id as reads return it, the attribute, the value and
 * the text that supports it. `confidence` is the module's own (0 to 1, 0.5 when absent); `validFrom` when the value
 * became true (ms).
 */
export type ProposedFact = { id: string; attribute: string; value: FactValue; evidence: string; confidence?: number; validFrom?: number };
export type FactsProposeArgs = { object: FactObject; facts: ProposedFact[] };
/** Why a proposed fact was not stored. A record the caller can't see reads as `unknown_record`, as one that doesn't exist. */
export type FactRejection = "unknown_record" | "unknown_attribute" | "field_locked" | "not_owned" | "invalid_value";

/** The most facts one `facts.propose` holds: a call's 5 proposals then fill one review batch of 500. */
export const FACTS_PROPOSE_MAX = 100;
/** The most evidence a fact keeps, as every proposal to the ledger. */
export const FACT_EVIDENCE_MAX = 4000;

/**
 * Why `args` aren't a `facts.propose`'s arguments, or null: an object, 1 to 100 facts, each naming a record and an
 * attribute, with a scalar value and non-empty evidence. Their shape only: factsProposeProblem also checks the grant.
 */
export function factsProposeArgsProblem(args: unknown): string | null {
  const a = (args ?? {}) as Record<string, unknown>;
  const extra = Object.keys(a).filter((k) => k !== "object" && k !== "facts");
  if (extra.length) return `facts.propose takes no ${extra.join(", ")}`;
  if (typeof a.object !== "string" || !(FACT_OBJECTS as readonly string[]).includes(a.object)) return `facts.propose proposes facts of ${FACT_OBJECTS.join(", ")}`;
  const facts = a.facts;
  if (!Array.isArray(facts) || !facts.length || facts.length > FACTS_PROPOSE_MAX) return `facts.propose needs 1 to ${FACTS_PROPOSE_MAX} facts`;
  const scalar = (v: unknown) => v === null || typeof v === "string" || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v));
  for (const [i, f] of facts.entries()) {
    const at = `facts.propose's fact ${i}`;
    if (typeof f !== "object" || f === null || Array.isArray(f)) return `${at} is { id, attribute, value, evidence, confidence?, validFrom? }`;
    const x = f as Record<string, unknown>;
    const unknown = Object.keys(x).filter((k) => !["id", "attribute", "value", "evidence", "confidence", "validFrom"].includes(k));
    if (unknown.length) return `${at} takes no ${unknown.join(", ")}`;
    if (typeof x.id !== "string" || !x.id || x.id.length > 200) return `${at} needs id, a record's id`;
    if (typeof x.attribute !== "string" || !FACT_ATTRIBUTE.test(x.attribute)) return `${at} needs attribute, as industry or custom.<slug>`;
    if (!scalar(x.value)) return `${at}'s value is text, a number, true or false, or null`;
    if (typeof x.evidence !== "string" || !x.evidence.trim() || x.evidence.length > FACT_EVIDENCE_MAX) return `${at} needs evidence, the text that supports it (1 to ${FACT_EVIDENCE_MAX} characters)`;
    if (x.confidence !== undefined && (typeof x.confidence !== "number" || !(x.confidence >= 0 && x.confidence <= 1))) return `${at}'s confidence is 0 to 1`;
    if (x.validFrom !== undefined && (typeof x.validFrom !== "number" || !Number.isFinite(x.validFrom))) return `${at}'s validFrom is a time in ms`;
  }
  return null;
}

/**
 * Why a module may not propose `args`, or null: their shape, and every attribute must be one its
 * `facts.<object>.propose` declares. A module that declares none may propose none; an undeclared attribute refuses
 * the proposal, as it refuses a read.
 */
export function factsProposeProblem(args: unknown, decl: FactsDecl | undefined): string | null {
  const problem = factsProposeArgsProblem(args);
  if (problem) return problem;
  const a = args as FactsProposeArgs;
  const declared = decl?.[a.object]?.propose ?? [];
  const undeclared = [...new Set(a.facts.map((f) => f.attribute).filter((x) => !declared.includes(x)))];
  return undeclared.length ? `This module doesn't declare facts.${a.object}.propose ${undeclared.join(", ")}` : null;
}
