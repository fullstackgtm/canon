/**
 * Bring a whole HubSpot portal across (CP12, docs/core-crm-parity.md): what an import reads, in what order, and how
 * each HubSpot value becomes a Canon one. The run (convex/hubspotImport.ts) steps through PHASES one HubSpot page at
 * a time and saves its cursor after each, so a stopped import resumes where it was. Every write is keyed by the
 * HubSpot id (the mirror rows' `crmId`, the edges' ends), so a re-run or a replayed page changes nothing twice.
 *
 * Records go through the mirror's own upserts (lib/hubspotMirror.ts), so the scheduled sync and an import agree on
 * every value they both write. The import adds what the sync leaves out: pipelines, lifecycle stage and lead
 * status, every company a person is at with the primary one, parent companies, and people on deals in their roles.
 *
 * Pure: no database access, no Node-only imports.
 */
import type { HsAssociation, HsHistoryEntry, HsOwner, HsPipeline, HsProperty } from "../../engine/src/sync/hubspotImport/client.ts";
import { resolvePipelines, type ForecastCategory, type PipelineWrite, type StageConfig, type StoredPipeline } from "./pipelines.ts";
import type { DealRole, PicklistOption } from "./objects/registry.ts";

/**
 * What a person picks on the import screen. `links`: every company per person, parents, people on deals.
 * `engagements`: calls, meetings, notes, tasks and logged emails. `custom`: the portal's own properties as custom
 * fields. `history`: the dated past values of lifecycle stage, deal stage, amount and owner.
 */
export const IMPORT_OBJECTS = ["companies", "contacts", "deals", "links", "engagements", "custom", "history"] as const;
export type ImportObject = (typeof IMPORT_OBJECTS)[number];

export const ENGAGEMENTS = ["calls", "meetings", "notes", "tasks", "emails"] as const;
export type Engagement = (typeof ENGAGEMENTS)[number];

export const PHASES = ["owners", "pipelines", "properties", "companies", "contacts", "deals", "parents", "contactCompanies", "dealContacts", ...ENGAGEMENTS, "done"] as const;
export type Phase = (typeof PHASES)[number];

const PHASE_OBJECT: Readonly<Record<Phase, ImportObject | null>> = {
  owners: null, pipelines: "deals", properties: "custom", companies: "companies", contacts: "contacts", deals: "deals",
  parents: "links", contactCompanies: "links", dealContacts: "links",
  calls: "engagements", meetings: "engagements", notes: "engagements", tasks: "engagements", emails: "engagements", done: null,
};

/** The phase after `phase` that the chosen objects need. Owners always run: every record's owner is mapped from them. */
export function nextPhase(phase: Phase, objects: readonly ImportObject[]): Phase {
  for (const p of PHASES.slice(PHASES.indexOf(phase) + 1)) if (phaseNeeded(p, objects)) return p;
  return "done";
}

/** Whether a run importing `objects` goes through `phase`. */
export const phaseNeeded = (phase: Phase, objects: readonly ImportObject[]) => {
  const needs = PHASE_OBJECT[phase];
  return needs === null || objects.includes(needs);
};

/**
 * Phases that read and write independently of each other, so a step runs them side by side (each with its own
 * cursor, a lane): the links, which need every record written first, and the engagements, which need the links' records.
 */
export const PARALLEL_STAGES: ReadonlyArray<readonly Phase[]> = [["parents", "contactCompanies", "dealContacts"], ENGAGEMENTS];

/** The parallel stage `phase` belongs to, if any. */
export const stageOf = (phase: Phase) => PARALLEL_STAGES.find((s) => s.includes(phase));

export type Lane = { phase: string; cursor: string | null; done: boolean };

/**
 * The lanes of the stage a run is at: the run's own when it has them, else fresh ones for the stage's needed phases.
 * A run that reached the stage before lanes existed (one phase at a time) has finished the phases before its own.
 */
export function lanesFor(run: { phase: string; cursor: string | null; objects: readonly string[]; lanes?: Lane[] }, stage: readonly Phase[]): Lane[] {
  if (run.lanes?.length) return run.lanes.map((l) => ({ ...l }));
  const at = stage.indexOf(run.phase as Phase);
  return stage.filter((p) => phaseNeeded(p, run.objects as ImportObject[])).map((p) => {
    const i = stage.indexOf(p);
    return { phase: p, cursor: i === at ? run.cursor : null, done: i < at };
  });
}

/** The run's results row each phase counts into. */
export const PHASE_RESULT: Readonly<Partial<Record<Phase, string>>> = {
  owners: "owners", pipelines: "pipelines", properties: "custom fields", companies: "companies", contacts: "contacts", deals: "deals",
  parents: "parent companies", contactCompanies: "people at companies", dealContacts: "people on deals",
  calls: "calls", meetings: "meetings", notes: "notes", tasks: "tasks", emails: "emails",
};

// Owners ---------------------------------------------------------------------

/** A HubSpot owner and who in Canon holds their records. `member`: a person in the workspace has their email. */
export type OwnerMatch = { crmOwnerId: string; name: string; email: string | null; archived: boolean; userId: string | null; member: boolean; records: number };

export const ownerName = (o: HsOwner) => [o.firstName, o.lastName].filter(Boolean).join(" ") || o.email || `Owner ${o.id}`;

/**
 * Match owners to the workspace's members by email. `members` are the users with those emails; a CRM placeholder
 * (a user the sync made for an owner nobody signed up as) is not a member. An unmatched owner's records keep the
 * placeholder the sync gives them, and the import screen lists the owner so an admin can invite them.
 */
export function matchOwners(owners: readonly HsOwner[], members: ReadonlyMap<string, { userId: string; placeholder: boolean }>, ownerMap: Readonly<Record<string, string>>): OwnerMatch[] {
  return owners.map((o) => {
    const email = o.email?.trim().toLowerCase() || null;
    const member = email ? members.get(email) : undefined;
    return {
      crmOwnerId: String(o.id), name: ownerName(o), email, archived: o.archived === true,
      userId: ownerMap[String(o.id)] ?? null, member: member !== undefined && !member.placeholder, records: 0,
    };
  });
}

// Contacts -------------------------------------------------------------------

/** HubSpot's lifecycle stages (internal values) to Canon's. A portal's own stage (a numeric id) is `other`. */
export const LIFECYCLE_STAGES: Readonly<Record<string, string>> = {
  subscriber: "subscriber", lead: "lead", marketingqualifiedlead: "mql", salesqualifiedlead: "sql",
  opportunity: "opportunity", customer: "customer", evangelist: "evangelist", other: "other",
};

/** HubSpot's lead statuses to Canon's five. A portal's own status has no Canon value and is left out. */
export const LEAD_STATUSES: Readonly<Record<string, string>> = {
  NEW: "new", OPEN: "working", IN_PROGRESS: "working", ATTEMPTED_TO_CONTACT: "working", CONNECTED: "working",
  OPEN_DEAL: "qualified", BAD_TIMING: "nurturing", UNQUALIFIED: "unqualified",
};

/** The properties a contact page reads on top of the mirror's. */
export const CONTACT_IMPORT_PROPERTIES = ["lifecyclestage", "hs_lead_status", "hs_additional_emails", "mobilephone"] as const;

/** HubSpot's semicolon-separated list (hs_additional_emails), its blanks and the primary left out. */
const otherValues = (raw: string | null | undefined, primary: string | null | undefined) => {
  const out = (raw ?? "").split(";").map((v) => v.trim()).filter((v) => v && v.toLowerCase() !== (primary ?? "").trim().toLowerCase());
  return out.length ? [...new Set(out)] : null;
};

/**
 * A contact's lifecycle stage and lead status as Canon values, and its other emails and mobile phone as the
 * person's standard lists (#299); a value HubSpot has that Canon cannot hold is reported.
 */
export function contactExtras(props: Readonly<Record<string, string | null | undefined>>): {
  values: { lifecycleStage: string | null; leadStatus: string | null; additionalEmails: string[] | null; additionalPhones: string[] | null }; unmapped: string[];
} {
  const stage = props.lifecyclestage?.trim() || null;
  const status = props.hs_lead_status?.trim() || null;
  const unmapped = status && !LEAD_STATUSES[status] ? [`lead status ${status}`] : [];
  return {
    values: {
      lifecycleStage: stage ? (LIFECYCLE_STAGES[stage] ?? "other") : null, leadStatus: status ? (LEAD_STATUSES[status] ?? null) : null,
      additionalEmails: otherValues(props.hs_additional_emails, props.email), additionalPhones: otherValues(props.mobilephone, props.phone),
    },
    unmapped,
  };
}

// Pipelines ------------------------------------------------------------------

/** A HubSpot stage's Canon settings: its id is the stage value (the sync already stores deals' stages by it). */
export function stageConfig(stage: HsPipeline["stages"][number]): StageConfig {
  const probability = Math.round(Math.min(1, Math.max(0, Number(stage.metadata?.probability ?? 0) || 0)) * 100);
  const closed = String(stage.metadata?.isClosed).toLowerCase() === "true";
  const forecastCategory: ForecastCategory = closed ? (probability === 100 ? "closed_won" : "closed_lost") : "pipeline";
  return { value: String(stage.id), probability, forecastCategory };
}

/**
 * The deal stage options and pipeline rows that make Canon's pipelines HubSpot's: one Canon pipeline per HubSpot
 * pipeline, in HubSpot's order, each holding its stages by their HubSpot ids with HubSpot's labels. A Canon
 * pipeline that already holds one of a HubSpot pipeline's stages is that pipeline (a re-run replaces it); it keeps
 * any stage HubSpot no longer lists, since removing a stage would move its deals. As a first pipeline save does, an
 * org with none stored first stores its default, so Canon's default stays the default.
 */
export function planHubspotPipelines(options: readonly PicklistOption[], stored: readonly StoredPipeline[], pipelines: readonly HsPipeline[]): { options: PicklistOption[]; writes: PipelineWrite[] } {
  const live = [...pipelines].filter((p) => !p.archived).sort((a, b) => (a.displayOrder ?? 0) - (b.displayOrder ?? 0));
  const hsValues = new Set(live.flatMap((p) => p.stages.map((s) => String(s.id))));
  const next = [...options];
  for (const p of live) {
    for (const s of p.stages) {
      const option = { value: String(s.id), label: s.label.trim().slice(0, 80) || String(s.id), active: !s.archived };
      const i = next.findIndex((o) => o.value === option.value);
      if (i >= 0) next[i] = { ...next[i], label: option.label, active: option.active };
      else next.push(option);
    }
  }
  const writes: PipelineWrite[] = [];
  const used = new Set<string>();
  if (!stored.length) {
    const virtual = resolvePipelines(next.filter((o) => !hsValues.has(o.value)), [])[0];
    if (virtual.stages.length) writes.push({ kind: "insert", name: virtual.name, stages: virtual.stages.map(({ value, probability, forecastCategory }) => ({ value, probability, forecastCategory })) });
  }
  for (const p of live) {
    const stages = [...p.stages].sort((a, b) => (a.displayOrder ?? 0) - (b.displayOrder ?? 0)).map(stageConfig);
    const values = new Set(stages.map((s) => s.value));
    // A stored pipeline holding stages of two HubSpot pipelines becomes the first; the second is inserted.
    const holder = stored.find((h) => !used.has(h.id) && h.stages.some((s) => values.has(s.value)));
    const name = p.label.trim().slice(0, 80) || `Pipeline ${p.id}`;
    if (!holder) {
      writes.push({ kind: "insert", name, stages });
      continue;
    }
    used.add(holder.id);
    const kept = holder.stages.filter((s) => !values.has(s.value) && !hsValues.has(s.value));
    writes.push({ kind: "replace", id: holder.id, name, stages: [...stages, ...kept] });
  }
  return { options: next, writes };
}

// Associations ---------------------------------------------------------------

/** HubSpot's primary association types: contact to company (1) and deal to company (5). */
const PRIMARY_TYPE_IDS = new Set([1, 5]);
const isPrimary = (a: HsAssociation) => a.associationTypes.some((t) => (t.category === "HUBSPOT_DEFINED" && PRIMARY_TYPE_IDS.has(t.typeId)) || t.label === "Primary");

/** A person's companies with the primary first; the first company is primary when HubSpot marks none. */
export function companiesOf(assocs: readonly HsAssociation[]): { primary: string | null; companies: string[] } {
  const ids = [...new Set(assocs.map((a) => a.toObjectId))];
  const primary = assocs.find(isPrimary)?.toObjectId ?? ids[0] ?? null;
  return { primary, companies: primary ? [primary, ...ids.filter((id) => id !== primary)] : ids };
}

/**
 * HubSpot deal-to-contact labels to Canon's deal roles, matched in this order by the words a label contains.
 * A label that matches none, and an unlabelled association, is `involved`.
 */
export const ROLE_WORDS: ReadonlyArray<readonly [DealRole, readonly string[]]> = [
  ["signer", ["signer", "signatory", "signing"]],
  ["champion", ["champion"]],
  ["n1", ["n-1", "n1"]],
  ["procurement", ["procurement", "purchasing", "legal"]],
  ["security", ["security", "infosec"]],
  ["executive", ["decision maker", "economic buyer", "executive", "exec sponsor", "budget"]],
  ["user", ["user"]],
];

export function dealRoleOf(assoc: HsAssociation): DealRole {
  const labels = assoc.associationTypes.filter((t) => t.category !== "HUBSPOT_DEFINED" && t.label).map((t) => t.label!.toLowerCase());
  for (const [role, words] of ROLE_WORDS) if (labels.some((l) => words.some((w) => l.includes(w)))) return role;
  return "involved";
}

// Engagements ----------------------------------------------------------------

type Props = Readonly<Record<string, string | null | undefined>>;

/** The properties each engagement page reads. */
export const ENGAGEMENT_PROPERTIES: Readonly<Record<Engagement, readonly string[]>> = {
  calls: ["hs_timestamp", "hubspot_owner_id", "hs_call_title", "hs_call_body", "hs_call_direction", "hs_call_duration", "hs_call_disposition", "hs_call_recording_url"],
  meetings: ["hs_timestamp", "hubspot_owner_id", "hs_meeting_title", "hs_meeting_body", "hs_meeting_start_time", "hs_meeting_end_time", "hs_meeting_location", "hs_meeting_outcome"],
  notes: ["hs_timestamp", "hubspot_owner_id", "hs_note_body", "hs_attachment_ids"],
  tasks: ["hs_timestamp", "hubspot_owner_id", "hs_task_subject", "hs_task_body", "hs_task_status", "hs_task_priority"],
  emails: ["hs_timestamp", "hubspot_owner_id", "hs_email_subject", "hs_email_text", "hs_email_html", "hs_email_direction", "hs_email_from_email", "hs_email_to_email"],
};

/** HubSpot's rich-text bodies (notes, call and meeting notes, task bodies) as plain text: paragraphs and line breaks kept, tags dropped. */
export function htmlText(html: string | null | undefined): string | null {
  if (!html?.trim()) return null;
  const text = html
    .replace(/<\s*br\s*\/?>/gi, "\n").replace(/<\/(p|div|li|h[1-6])\s*>/gi, "\n").replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return text || null;
}

const time = (v: string | null | undefined): number | null => {
  if (!v) return null;
  const n = /^\d+$/.test(v) ? Number(v) : Date.parse(v);
  return Number.isFinite(n) ? n : null;
};
const text = (v: string | null | undefined) => v?.trim() || null;

/** HubSpot's default call outcomes (`hs_call_disposition` ids). A portal's own outcome has no Canon value. */
export const CALL_OUTCOMES: Readonly<Record<string, string>> = {
  "f240bbac-87c9-4f6e-bf70-924b57d47db7": "connected",
  "73a0d17f-1163-4015-bdd5-ec830791da20": "no_answer",
  "b2cf5968-551e-4856-9783-52b3da59a7d0": "left_voicemail",
  "a4c4c377-d246-4b32-a13b-75a56a4cd0ff": "left_voicemail",
  "9d9162e7-6cf3-4944-bf63-4dff82258764": "busy",
  "17b47fee-58de-441e-a44c-c6300d46f273": "wrong_number",
};
const TASK_STATUSES: Readonly<Record<string, string>> = { NOT_STARTED: "not_started", IN_PROGRESS: "in_progress", WAITING: "waiting", COMPLETED: "completed", DEFERRED: "deferred" };
const TASK_PRIORITIES: Readonly<Record<string, string>> = { LOW: "low", MEDIUM: "normal", HIGH: "high" };
const MEETING_OUTCOMES: Readonly<Record<string, string>> = { SCHEDULED: "scheduled", COMPLETED: "completed", RESCHEDULED: "rescheduled", NO_SHOW: "no_show", CANCELED: "canceled", CANCELLED: "canceled" };

const compact = (o: Record<string, string | number | null | undefined>) =>
  Object.fromEntries(Object.entries(o).filter((e): e is [string, string | number] => e[1] !== null && e[1] !== undefined && e[1] !== ""));

/** A note's attachments, as the note's last paragraph: each file's name and link, or its HubSpot id when the token cannot read files. */
export function attachmentText(ids: readonly string[], files: ReadonlyMap<string, { name: string; url: string | null }>): string | null {
  if (!ids.length) return null;
  return `Attachments: ${ids.map((id) => {
    const f = files.get(id);
    return f ? (f.url ? `${f.name} (${f.url})` : f.name) : `HubSpot file ${id}`;
  }).join("; ")}`;
}

export const attachmentIds = (props: Props) => (props.hs_attachment_ids ?? "").split(";").map((x) => x.trim()).filter(Boolean);

/** A logged email: who sent it to whom, its subject and text, and which way it went. */
export type LoggedEmail = { direction: "inbound" | "outbound"; from: string; to: string; subject: string; body: string; at: number };

/**
 * An engagement as Canon holds it: a call, meeting, note or task as that registry object's values (owner and links
 * added by the caller), dated by HubSpot's timestamp; an email as a logged email on its people's timelines.
 */
export type MappedEngagement =
  | { kind: "activity"; object: "call" | "meeting" | "note" | "task"; values: Record<string, string | number>; createdAt: number | null; ownerCrmId: string | null }
  | { kind: "email"; email: LoggedEmail; ownerCrmId: string | null };

export function engagementOf(object: Engagement, record: { properties: Props; createdAt?: string }, attachments = ""): MappedEngagement {
  const p = record.properties;
  const at = time(p.hs_timestamp) ?? time(record.createdAt) ?? null;
  const created = time(record.createdAt) ?? at;
  const ownerCrmId = text(p.hubspot_owner_id);
  switch (object) {
    case "calls":
      return {
        kind: "activity", object: "call", createdAt: at, ownerCrmId,
        values: compact({
          subject: text(p.hs_call_title), notes: htmlText(p.hs_call_body), callAt: at,
          direction: p.hs_call_direction === "INBOUND" ? "inbound" : p.hs_call_direction === "OUTBOUND" ? "outbound" : null,
          durationSeconds: time(p.hs_call_duration) === null ? null : Math.round(Number(p.hs_call_duration) / 1000),
          outcome: p.hs_call_disposition ? CALL_OUTCOMES[p.hs_call_disposition] ?? null : null, recordingUrl: text(p.hs_call_recording_url),
        }),
      };
    case "meetings": {
      const start = time(p.hs_meeting_start_time) ?? at;
      return {
        kind: "activity", object: "meeting", createdAt: created, ownerCrmId,
        values: compact({
          title: text(p.hs_meeting_title) ?? "Meeting", startAt: start, endAt: time(p.hs_meeting_end_time), location: text(p.hs_meeting_location),
          outcome: p.hs_meeting_outcome ? MEETING_OUTCOMES[p.hs_meeting_outcome.toUpperCase()] ?? null : null, notes: htmlText(p.hs_meeting_body),
        }),
      };
    }
    case "notes":
      return { kind: "activity", object: "note", createdAt: at, ownerCrmId, values: compact({ body: [htmlText(p.hs_note_body), attachments || null].filter(Boolean).join("\n\n") || "(empty note)" }) };
    case "tasks":
      return {
        kind: "activity", object: "task", createdAt: created, ownerCrmId,
        values: compact({
          subject: text(p.hs_task_subject) ?? "Task", description: htmlText(p.hs_task_body),
          status: p.hs_task_status ? TASK_STATUSES[p.hs_task_status] ?? null : null, priority: p.hs_task_priority ? TASK_PRIORITIES[p.hs_task_priority] ?? null : null,
          dueDate: at === null ? null : new Date(at).toISOString().slice(0, 10),
        }),
      };
    case "emails":
      return {
        kind: "email", ownerCrmId,
        email: {
          direction: p.hs_email_direction === "INCOMING_EMAIL" ? "inbound" : "outbound",
          from: text(p.hs_email_from_email) ?? "", to: text(p.hs_email_to_email) ?? "",
          subject: text(p.hs_email_subject) ?? "", body: text(p.hs_email_text) ?? htmlText(p.hs_email_html) ?? "", at: at ?? 0,
        },
      };
  }
}

// Custom properties ----------------------------------------------------------

export type CustomType = "text" | "number" | "date" | "datetime" | "checkbox" | "picklist" | "multipicklist";
export type PartyOrDeal = "account" | "contact" | "deal";
export const CUSTOM_OBJECTS: Readonly<Record<PartyOrDeal, "companies" | "contacts" | "deals">> = { account: "companies", contact: "contacts", deal: "deals" };

/** A HubSpot property as a Canon custom field: its type, and for a picklist its options by HubSpot value. */
export type CustomSpec = { object: PartyOrDeal; property: string; label: string; type: CustomType; options: Array<{ value: string; label: string }> };
/** A spec once its field exists: the field's apiName and each HubSpot option value's Canon value. */
export type CustomField = { object: PartyOrDeal; property: string; apiName: string; type: CustomType; options: Array<{ hubspot: string; canon: string }> };

/**
 * The portal's own properties as Canon custom fields. HubSpot's properties and calculated ones are left out, and
 * so is a multi-select on deals (a deal field holds one value). Types: enumeration with a checkbox per option is a
 * multi-select, a single checkbox is a checkbox, any other enumeration is a picklist; number, date and datetime keep
 * their type; everything else is text.
 */
export function customSpecs(object: PartyOrDeal, props: readonly HsProperty[]): CustomSpec[] {
  return props.flatMap((p): CustomSpec[] => {
    if (p.hubspotDefined || p.calculated || p.archived || p.fieldType === "calculation_equation") return [];
    const options = (p.options ?? []).filter((o) => !o.hidden).map((o) => ({ value: o.value, label: o.label.trim() || o.value }));
    const type: CustomType = p.type === "bool" || p.fieldType === "booleancheckbox" ? "checkbox"
      : p.type === "enumeration" ? (p.fieldType === "checkbox" ? "multipicklist" : "picklist")
      : p.type === "number" ? "number"
      : p.type === "date" ? "date" : p.type === "datetime" ? "datetime"
      : "text";
    if (type === "multipicklist" && object === "deal") return [];
    return [{ object, property: p.name, label: p.label.trim().slice(0, 80) || p.name, type, options: type === "picklist" || type === "multipicklist" ? options : [] }];
  });
}

/** A HubSpot value as the custom field holds it; undefined when it does not fit (a number that is not one, an option HubSpot no longer lists). */
export function customValue(field: CustomField, raw: string | null | undefined): string | number | boolean | string[] | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null || raw === "") return null;
  const option = (v: string) => field.options.find((o) => o.hubspot === v)?.canon;
  switch (field.type) {
    case "number": {
      const n = Number(raw);
      return Number.isFinite(n) ? n : undefined;
    }
    case "checkbox": return raw === "true" ? true : raw === "false" ? false : undefined;
    case "date": {
      const t = /^\d+$/.test(raw) ? Number(raw) : Date.parse(raw);
      return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : undefined;
    }
    case "datetime": {
      const t = /^\d+$/.test(raw) ? Number(raw) : Date.parse(raw);
      return Number.isFinite(t) ? t : undefined;
    }
    case "picklist": return option(raw);
    case "multipicklist": {
      const values = raw.split(";").map((v) => option(v.trim()));
      return values.every((v) => v !== undefined) ? (values as string[]) : undefined;
    }
    case "text": return raw;
  }
}

/** A record's custom values for the fields of its object. */
export function customValues(object: PartyOrDeal, fields: readonly CustomField[], props: Readonly<Record<string, string | null | undefined>>): Record<string, string | number | boolean | string[] | null> {
  const out: Record<string, string | number | boolean | string[] | null> = {};
  for (const f of fields) {
    if (f.object !== object) continue;
    const value = customValue(f, props[f.property]);
    if (value !== undefined) out[f.apiName] = value;
  }
  return out;
}

// Property history -----------------------------------------------------------

/** The properties whose past values come across, per object, and the Canon field each becomes. */
export const HISTORY_FIELDS: Readonly<Record<"companies" | "contacts" | "deals", Readonly<Record<string, string>>>> = {
  companies: { hubspot_owner_id: "ownerId" },
  contacts: { lifecyclestage: "lifecycleStage", hubspot_owner_id: "ownerId" },
  deals: { dealstage: "stage", amount: "amount", hubspot_owner_id: "crmOwnerId" },
};
/** Past values one record brings per property; HubSpot keeps up to 45 days of some, years of others. */
export const HISTORY_PER_PROPERTY = 50;

export type HistoryFact = { field: string; value: string | number | null; at: number; ref: string };

/**
 * A record's property history as dated facts, each its own source record (`hubspot-history:<object>:<id>:<property>:<time>`),
 * so a re-run finds every one again and appends nothing. The newest entry is the value the record holds now and is
 * kept too: it dates the current value. `ownerOf` gives an owner's Canon value; an owner it has none for is left out.
 */
export function historyFacts(object: "companies" | "contacts" | "deals", id: string, history: Readonly<Record<string, readonly HsHistoryEntry[]>> | undefined, ownerOf: (crmOwnerId: string) => string | undefined): HistoryFact[] {
  const fields = HISTORY_FIELDS[object];
  return Object.entries(history ?? {}).flatMap(([property, entries]) => {
    const field = fields[property];
    if (!field) return [];
    return entries.slice(0, HISTORY_PER_PROPERTY).flatMap((e): HistoryFact[] => {
      const at = Date.parse(e.timestamp);
      if (!Number.isFinite(at)) return [];
      const raw = e.value === "" ? null : e.value;
      let value: string | number | null = raw;
      if (field === "lifecycleStage" && raw) value = LIFECYCLE_STAGES[raw] ?? "other";
      if (field === "amount" && raw !== null) {
        const n = Number(raw);
        if (!Number.isFinite(n)) return [];
        value = Math.round(n * 100);
      }
      if ((field === "ownerId" || field === "crmOwnerId") && raw !== null) {
        const owner = ownerOf(raw);
        if (!owner) return [];
        value = owner;
      }
      return [{ field, value, at, ref: `hubspot-history:${object}:${id}:${property}:${at}` }];
    });
  });
}

// Spot check -----------------------------------------------------------------

export const SPOT_SAMPLE = 50;
/** Records the spot check reads per object to sample from: the first pages of the portal. */
export const SPOT_POOL = 500;

/** `n` of `items`, the same ones for the same seed (mulberry32), in their original order. */
export function sampleOf<T>(items: readonly T[], n: number, seed: number): T[] {
  if (items.length <= n) return [...items];
  let a = seed >>> 0;
  const rand = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const picked = new Set<number>();
  while (picked.size < n) picked.add(Math.floor(rand() * items.length));
  return [...picked].sort((x, y) => x - y).map((i) => items[i]);
}

export type SpotValue = string | number | boolean | null;
export type Mismatch = { id: string; name: string; field: string; hubspot: string | null; canon: string | null };

const show = (v: SpotValue | readonly string[] | undefined) => (v === undefined || v === null || v === "" ? null : Array.isArray(v) ? [...v].sort().join(", ") : String(v));

/** Field by field, what HubSpot says the record should be against what Canon holds. */
export function compareRecord(id: string, name: string, expected: Readonly<Record<string, SpotValue | readonly string[]>>, actual: Readonly<Record<string, SpotValue | readonly string[] | undefined>> | null): Mismatch[] {
  if (!actual) return [{ id, name, field: "record", hubspot: id, canon: null }];
  return Object.entries(expected).flatMap(([field, want]) => {
    const [h, c] = [show(want), show(actual[field])];
    return h === c ? [] : [{ id, name, field, hubspot: h, canon: c }];
  });
}
