/**
 * Canon tools for the hosted MCP endpoint (and the canon CLI, which is an MCP
 * client of it).
 *
 * Every tool runs as the authenticated user through the normal Convex
 * functions, so their role and org checks apply: a connection can do what
 * its user can do in the dashboard, no more (docs/remote-mcp.md). Writes go
 * through the same mutations the pages use, so the ledger, version checks and
 * dedupe apply exactly as they do there.
 */
import type { ConvexHttpClient } from "convex/browser";
import { z } from "zod/v4";
import { api } from "../../../convex/_generated/api.js";
import type { Id } from "../../../convex/_generated/dataModel.js";
import { canonConversationTools } from "./_canonConversationTools.ts";
import { canonLinkedinTools } from "./_canonLinkedinTools.ts";
import { canonJobTools } from "./_canonJobTools.ts";
import { canonModuleTools } from "./_canonModuleTools.ts";
import { canonRelationTools } from "./_canonRelationTools.ts";
import { canonReportTools } from "./_canonReportTools.ts";
import { explainConvexError } from "../../lib/convexErrorText.ts";
import { FILTER_OPS, type FilterOp } from "../../../convex/lib/objects/listSpec.ts";

export type CanonTool = {
  name: string;
  description: string;
  inputSchema: z.ZodRawShape;
  /** Writes anything at all. */
  writes: boolean;
  /** Deletes or overwrites values (MCP's destructiveHint). */
  destructive?: boolean;
  run: (convex: ConvexHttpClient, args: Record<string, unknown>) => Promise<unknown>;
};

/** What an agent reads when a tool call fails. Grouped tools take { action, args }, so their argument errors name args.<field>. */
export function toolErrorMessage(tool: Pick<CanonTool, "name" | "inputSchema">, args: Record<string, unknown>, error: unknown): string {
  const explained = explainConvexError(error);
  if (explained.kind === "invalid_argument" && explained.field && "args" in tool.inputSchema) {
    return `${tool.name} ${String(args.action)}: args.${explained.message}`;
  }
  return explained.message;
}

/** Grouped-tool actions that read: a null from one of these means nothing matched. */
const READ_ACTION = /^(get|read|status|session|thread|view|describe|for_[a-z_]+|list[a-z_]*|history|runs|answers|contact_answers)$/;

/** What an agent reads for a result. A null from a lookup means nothing matched; a null from a write means it succeeded. */
export function toolResultText(tool: Pick<CanonTool, "name" | "writes">, args: Record<string, unknown>, result: unknown): string {
  if (result === null || result === undefined) {
    const lookup = !tool.writes || (typeof args.action === "string" && READ_ACTION.test(args.action));
    return JSON.stringify(lookup
      ? { found: false, note: `${tool.name} found nothing for ${JSON.stringify(args)}. Check the ids against a list or find call.` }
      : { ok: true }, null, 2);
  }
  return JSON.stringify(result, null, 2);
}

const AGENT_SOURCES = ["agent_run", "enrichment", "call", "pipeline"] as const;
const DEAL_FIELDS = ["name", "amount", "currency", "closeDate", "stage", "forecastCategory", "probability", "isClosed", "isWon", "crmOwnerId", "dealType", "nextStep"] as const;

const ENTITY_TYPES = ["opportunity", "account", "contact"] as const;
/** Objects with list views (convex/objects.ts `list`). Accounts and contacts list from the register. */
const LISTED_OBJECTS = ["account", "contact", "deal", "lead", "task", "note", "call", "meeting", "product", "lineItem"] as const;
/** Objects created, deleted and restored by stream id (convex/lib/objects/write.ts LEDGER_OBJECTS). */
const LEDGER_OBJECTS = ["lead", "task", "note", "call", "meeting", "product", "lineItem"] as const;
/** An org's own object (CP7d): `custom_<slug>`, defined in Recipes, Data model; the workspace's registry says whether it exists. */
const CUSTOM_OBJECT = z.string().regex(/^custom_[a-z][a-z0-9_]{0,39}$/).describe("A custom object's id, custom_<slug> (canon_describe_object lists its fields)");
const listedObject = z.union([z.enum(LISTED_OBJECTS), CUSTOM_OBJECT]);
const ledgerObject = z.union([z.enum(LEDGER_OBJECTS), CUSTOM_OBJECT]);
const fieldValues = z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(z.string()), z.array(z.object({ userId: z.string(), percentage: z.number(), kind: z.enum(["revenue", "overlay"]) }).strict()).max(100)]))
  .describe("Field values keyed by field apiName (see canon_describe_object)");
const filterScalar = z.union([z.string(), z.number(), z.boolean()]);
const newKey = () => globalThis.crypto.randomUUID();

const factSchema = z.object({
  entityType: z.enum(ENTITY_TYPES).optional().describe("What the fact is about (default opportunity, i.e. a deal)"),
  dealId: z.string().optional().describe("Deal: Canon deal id (from canon_list_deals)"),
  accountId: z.string().optional().describe("Account: a synced CRM account row id"),
  contactId: z.string().optional().describe("Contact: a synced CRM contact row id"),
  crmProvider: z.enum(["salesforce", "hubspot"]).optional(),
  crmId: z.string().optional().describe("CRM record id of the deal, account or contact, with crmProvider"),
  entityId: z.string().optional().describe("Account/contact: Canon entity id (from canon_find_entity)"),
  recordId: z.string().optional().describe("Account/contact: record-service (TAM) id of a promoted row"),
  domain: z.string().optional().describe("Account: website domain of a company already in Canon"),
  email: z.string().optional().describe("Contact: email of a person already in Canon"),
  attribute: z.string().min(1).max(80).describe(
    `Deals: ${DEAL_FIELDS.join(", ")}. Accounts: name, domain, industry, employees, annualRevenue, country, linkedinUrl, ownerId, or custom.<slug>. ` +
    "Contacts: fullName, title, email, phone, linkedinUrl, ownerId, or custom.<slug>.",
  ),
  value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
  evidence: z.string().max(4000).optional().describe("Quote, call segment or URL that supports the value"),
  confidence: z.number().min(0).max(1).optional(),
  validFrom: z.number().int().optional().describe("When the value became true (ms since epoch)"),
}).strict();

function compactDeal(d: Record<string, unknown>) {
  const keep = ["_id", "name", "companyId", "amount", "currency", "stage", "closeDate", "forecastCategory", "probability", "isClosed", "isWon", "crmProvider", "crmId", "crmOwnerId", "nextStep", "updatedAt"];
  return Object.fromEntries(keep.filter((k) => d[k] !== undefined).map((k) => [k, d[k]]));
}

export const canonRecordTools: CanonTool[] = [
  {
    name: "canon_whoami",
    description: "The authenticated Canon user and organization this connection acts as, and their role.",
    inputSchema: {},
    writes: false,
    run: (convex) => convex.query(api.users.me, {}),
  },
  {
    name: "canon_list_deals",
    description: "List the organization's deals (most recent first, up to 200) with their canonical field values. Optional case-insensitive name filter.",
    inputSchema: { nameContains: z.string().max(200).optional(), limit: z.number().int().min(1).max(200).optional() },
    writes: false,
    run: async (convex, args) => {
      const deals = (await convex.query(api.deals.list, {})) as Array<Record<string, unknown>>;
      const needle = typeof args.nameContains === "string" ? args.nameContains.toLowerCase() : null;
      return deals
        .filter((d) => !needle || String(d.name ?? "").toLowerCase().includes(needle))
        .slice(0, typeof args.limit === "number" ? args.limit : 50)
        .map(compactDeal);
    },
  },
  {
    name: "canon_get_deal",
    description: "One deal's canonical fields, optionally as of a past time: knownAt (what Canon knew then) and/or validAt (what was true then), both ms since epoch.",
    inputSchema: { dealId: z.string(), knownAt: z.number().int().optional(), validAt: z.number().int().optional() },
    writes: false,
    run: async (convex, args) => {
      const dealId = args.dealId as Id<"deals">;
      const deal = await convex.query(api.deals.get, { dealId });
      if (!deal) return null;
      const fields = await convex.query(api.canon.dealAsOf, {
        dealId,
        ...(typeof args.knownAt === "number" ? { knownAt: args.knownAt } : {}),
        ...(typeof args.validAt === "number" ? { validAt: args.validAt } : {}),
      });
      return { deal: compactDeal(deal as Record<string, unknown>), fields };
    },
  },
  {
    name: "canon_field_receipts",
    description: "Every fact behind one field of one deal, newest first: value, status, source, actor, evidence, confidence, verification and who decided it.",
    inputSchema: { dealId: z.string(), attribute: z.enum(DEAL_FIELDS) },
    writes: false,
    run: (convex, args) => convex.query(api.canonGate.fieldReceipts, { dealId: args.dealId as Id<"deals">, attribute: String(args.attribute) }),
  },
  {
    name: "canon_find_entity",
    description: "An account or contact's Canon identity and canonical field values, found by entity id, record id, domain (accounts) or email (contacts). Null when it is not in Canon yet.",
    inputSchema: {
      entityType: z.enum(["account", "contact"]),
      entityId: z.string().optional(), recordId: z.string().optional(), domain: z.string().optional(), email: z.string().optional(),
    },
    writes: false,
    run: (convex, args) => convex.query(api.canonEntities.find, args as never),
  },
  {
    name: "canon_entity_receipts",
    description: "Every fact behind one field of an account, contact or deal (by Canon entity id), newest first, with evidence and decisions.",
    inputSchema: { entityId: z.string(), attribute: z.string().min(1).max(80) },
    writes: false,
    run: (convex, args) => convex.action(api.canonGate.entityReceiptsScoped, { entityId: args.entityId as Id<"canonEntities">, attribute: String(args.attribute) }),
  },
  {
    name: "canon_propose_facts",
    description:
      "Propose a batch of facts about deals, accounts or contacts for review (the write gate). Accounts and contacts must already be in Canon (a synced CRM row, or a TAM record promoted in the app). Proposals change no canonical value until a person accepts them in Canon, or an org auto-accept rule accepts them after an independent check of the value against its evidence. Fields the source does not own are rejected: by default a deal's owner, amount, stage, forecast, probability, closed/won, name, currency and type, an account's name, domain and owner, and a contact's owner. Always include evidence.",
    inputSchema: {
      agentId: z.string().min(1).max(200).describe("Stable name of the tool or workflow proposing, such as claude-code. Labels the batch; the facts are attributed to you. May not start with research: or agent:"),
      sourceKind: z.enum(AGENT_SOURCES),
      title: z.string().min(1).max(200),
      reason: z.string().max(2000).optional(),
      facts: z.array(factSchema).min(1).max(500),
    },
    writes: true,
    run: (convex, args) => convex.action(api.canonGate.proposeScoped, args as never),
  },
  {
    name: "canon_fact_batch_status",
    description: "A proposal batch's review status: counts of proposed, accepted and rejected facts, and each fact's decision.",
    inputSchema: { batchId: z.string() },
    writes: false,
    run: (convex, args) => convex.action(api.canonGate.myBatchStatusScoped, { patchPlanId: String(args.batchId) }),
  },
  {
    name: "canon_review_queue",
    description: "Facts awaiting review and contested fields (where peer sources disagree). Read-only: decisions are made by a person in Canon.",
    inputSchema: {},
    writes: false,
    run: (convex) => convex.action(api.canonGate.reviewQueueScoped, {}),
  },
  {
    name: "canon_hygiene_audit",
    description: "Run the read-only CRM hygiene audit over the organization's synced data and return findings with a dry-run patch plan.",
    inputSchema: { rule: z.string().optional(), staleDealDays: z.number().int().positive().optional() },
    writes: false,
    run: (convex, args) => convex.query(api.hygiene.preview, {
      format: "json",
      ...(typeof args.rule === "string" ? { rule: args.rule } : {}),
      ...(typeof args.staleDealDays === "number" ? { staleDealDays: args.staleDealDays } : {}),
    }),
  },
  {
    name: "canon_patch_plans",
    description: "List patch plans (CRM change sets and proposal batches) with their approval status, or get one plan with its operations by id.",
    inputSchema: {
      patchPlanId: z.string().optional(),
      status: z.enum(["draft", "pending_approval", "approved", "applied", "rejected", "cancelled", "failed"]).optional(),
      limit: z.number().int().min(1).max(100).optional(),
    },
    writes: false,
    run: (convex, args) => typeof args.patchPlanId === "string"
      ? convex.query(api.patchPlans.get, { patchPlanId: args.patchPlanId as Id<"patchPlans"> })
      : convex.query(api.patchPlans.list, {
        ...(typeof args.status === "string" ? { status: args.status as never } : {}),
        ...(typeof args.limit === "number" ? { limit: args.limit } : {}),
      }),
  },
  {
    name: "canon_describe_object",
    description: "An object's fields (apiName, type, picklist values) and what the caller may do with its records. Call before writing to an object.",
    inputSchema: { object: listedObject },
    writes: false,
    run: (convex, args) => convex.query(api.objects.describe, { object: String(args.object) }),
  },
  {
    name: "canon_list_records",
    description:
      "One page of an object's records with filters, sort and a keyset cursor; `total` counts all matches. Accounts and contacts list the whole register, worked or not, by record id; other objects by stream id. Field apiNames come from canon_describe_object.",
    inputSchema: {
      object: listedObject,
      filter: z.array(z.object({ field: z.string(), op: z.enum(FILTER_OPS as [FilterOp, ...FilterOp[]]), value: z.union([filterScalar, z.array(filterScalar)]).optional() })).optional(),
      sort: z.object({ field: z.string(), dir: z.enum(["asc", "desc"]) }).optional(),
      limit: z.number().int().min(1).max(200).optional(),
      cursor: z.string().optional(),
      deleted: z.boolean().optional().describe("List archived records instead"),
    },
    writes: false,
    run: (convex, args) => convex.action(api.objects.list, args as never),
  },
  {
    name: "canon_search_records",
    description: "Records whose title contains the text, across objects: titles that start with it first, then the most recently updated. Companies and people match on name, domain or email too, worked or not, and come back with their register record ids.",
    inputSchema: { q: z.string().min(1).max(200), objects: z.array(listedObject).optional(), limit: z.number().int().min(1).max(50).optional() },
    writes: false,
    run: (convex, args) => convex.action(api.objects.search, args as never),
  },
  {
    name: "canon_get_record",
    description: "One record's current values and version, by stream id (any object on the ledger), or an account by its register record id with its contacts.",
    inputSchema: { streamId: z.string().optional(), accountRecordId: z.string().optional() },
    writes: false,
    run: (convex, args) => {
      if (typeof args.streamId === "string") return convex.query(api.objects.get, { streamId: args.streamId as Id<"canonEntities"> });
      if (typeof args.accountRecordId === "string") return convex.action(api.records.get, { id: args.accountRecordId });
      throw new Error("Pass streamId or accountRecordId");
    },
  },
  {
    name: "canon_upsert_accounts",
    description:
      "Add up to 100 companies to the CRM, keyed by domain. A company already present keeps its values and only gains the fields it lacks; change existing values with canon_update_record. Returns the record ids. Pass the same idempotencyKey to retry a batch safely.",
    inputSchema: {
      accounts: z.array(z.object({
        domain: z.string().min(1), name: z.string().min(1), industry: z.string().optional(),
        employees: z.number().int().nonnegative().optional(), country: z.string().optional(), linkedinUrl: z.string().optional(),
      }).strict()).min(1).max(100),
      idempotencyKey: z.string().max(200).optional(),
    },
    writes: true,
    run: (convex, args) => convex.action(api.records.upsert, { object: "account", accounts: args.accounts as never, idempotencyKey: String(args.idempotencyKey ?? newKey()) }),
  },
  {
    name: "canon_upsert_contacts",
    description:
      "Add up to 100 people to the CRM, attached to a company by accountDomain (add the company first) or accountId. Duplicates are merged; an existing person only gains the fields they lack. Pass the same idempotencyKey to retry a batch safely.",
    inputSchema: {
      contacts: z.array(z.object({
        fullName: z.string().min(1), accountDomain: z.string().optional(), accountId: z.string().optional(),
        title: z.string().optional(), email: z.string().optional(), linkedinUrl: z.string().optional(),
      }).strict()).min(1).max(100),
      idempotencyKey: z.string().max(200).optional(),
    },
    writes: true,
    run: (convex, args) => convex.action(api.records.upsert, { object: "contact", contacts: args.contacts as never, idempotencyKey: String(args.idempotencyKey ?? newKey()) }),
  },
  {
    name: "canon_create_record",
    description: "Create a lead, task, note, call, meeting, product, deal line item or a record of a custom object. Line items require dealId and productId stream ids, positive integer quantity and an explicit totalPrice in integer hundredths; name is derived from the product. Link an activity to a company, contact or deal with accountId, contactId or dealId. Returns its stream id and version.",
    inputSchema: { object: ledgerObject, values: fieldValues },
    writes: true,
    run: (convex, args) => convex.mutation(api.objects.write, { object: args.object as never, values: args.values as never }),
  },
  {
    name: "canon_create_deal",
    description: "Create a deal (admins and managers). stage is one of the deal stage options (canon_describe_object deal) and puts the deal in that stage's pipeline. amount is in cents; closeDate is YYYY-MM-DD. primaryRepId is a Canon user id (see canon_whoami) and defaults to you. companyId is the company's record id (acc_…, from canon_search_records).",
    inputSchema: {
      name: z.string().min(1).max(200), amount: z.number().int().nonnegative().optional(), currency: z.string().length(3).optional(), closeDate: z.string(),
      stage: z.string(),
      dealType: z.enum(["new_business", "expansion", "renewal", "one_time"]).optional(), revenueType: z.enum(["one_time", "recurring"]).optional(),
      primaryRepId: z.string().optional(), companyId: z.string().optional(),
    },
    writes: true,
    run: (convex, args) => convex.action(api.deals.createScoped, args as never),
  },
  {
    name: "canon_update_record",
    description:
      "Change fields of one record. Accounts and contacts: pass the register record id as `id` (a first edit moves the record onto the ledger). Other objects: pass the stream id, and expectedVersion to fail on a concurrent change (status conflict) instead of overwriting it. Line-item changes and deal splitAllocations require expectedVersion. Credit splits are [{userId,percentage,kind:revenue|overlay}], with revenue totaling 100%; null clears splits. A line item's dealId cannot change. A null value clears an optional field.",
    inputSchema: {
      object: z.union([z.enum(["account", "contact", "deal", ...LEDGER_OBJECTS]), CUSTOM_OBJECT]),
      id: z.string(),
      values: fieldValues,
      expectedVersion: z.number().int().nonnegative().optional(),
    },
    writes: true,
    destructive: true,
    run: (convex, args) => {
      if (args.object === "account" || args.object === "contact") {
        return convex.action(api.records.edit, { object: args.object, id: String(args.id), patch: args.values as never, idempotencyKey: newKey() });
      }
      return convex.mutation(api.objects.write, {
        object: args.object as never, streamId: args.id as Id<"canonEntities">, values: args.values as never,
        ...(typeof args.expectedVersion === "number" ? { expectedVersion: args.expectedVersion } : {}),
      }).catch((error: unknown) => {
        // objects.write calls the record streamId; this tool calls it id.
        if (explainConvexError(error).field === "streamId") throw new Error(`No ${String(args.object)} with id ${String(args.id)}; canon_list_records returns ids`);
        throw error;
      });
    },
  },
  {
    name: "canon_find_contact_info",
    description:
      "Look up a person's work email or phone number and write what is found onto the contact. Email tries the workspace's own Deepline account first when one is connected (Deepline bills it; no Canon limit applies), then Canon's paid providers. accountId is the person's company record id (acc_…) and contactId their record id (con_…). Billed only on a hit, within the workspace's daily and monthly lookup limits; a person who already has one returns it without a lookup.",
    inputSchema: { kind: z.enum(["email", "phone"]), accountId: z.string(), contactId: z.string() },
    writes: true,
    run: (convex, args) => {
      const ids = { accountId: String(args.accountId), contactId: String(args.contactId) };
      return args.kind === "phone" ? convex.action(api.records.findPhone, ids) : convex.action(api.records.findEmail, ids);
    },
  },
  {
    name: "canon_delete_record",
    description: "Archive a deal, lead, task, note, call, meeting, product or custom object record (restore: true brings it back). An archived record leaves lists, search, reports and agents; nothing is erased.",
    inputSchema: { object: z.union([ledgerObject, z.literal("deal")]), streamId: z.string(), restore: z.boolean().optional(), expectedVersion: z.number().int().nonnegative().optional() },
    writes: true,
    destructive: true,
    run: (convex, args) => convex.mutation(args.restore === true ? api.objects.restore : api.objects.remove, {
      object: args.object as never, streamId: args.streamId as Id<"canonEntities">,
      ...(typeof args.expectedVersion === "number" ? { expectedVersion: args.expectedVersion } : {}),
    }),
  },
];

export const canonTools: CanonTool[] = [...canonRecordTools, ...canonJobTools, ...canonRelationTools, ...canonReportTools, ...canonModuleTools, ...canonConversationTools, ...canonLinkedinTools];
