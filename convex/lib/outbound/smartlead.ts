/**
 * Smartlead adapter: list campaigns and add leads to one, with the workspace's
 * own API key. Smartlead takes the key as a query parameter, so a request URL
 * is a secret: it never goes in an error or a log (client.ts).
 *
 * Pure: no database access, no Node-only imports.
 */
import { splitName, type OutboundContact } from "./audience.ts";
import { idOf, num, requestJson, str, type AddLeadsResult, type BeforeBatch, type OnBatch, type SequencerCampaign, type SequencerClient } from "./client.ts";

export const SMARTLEAD_BASE_URL = "https://server.smartlead.ai/api/v1";
/** Smartlead takes at most 100 leads per request. */
export const SMARTLEAD_BATCH = 100;

export type SmartleadLead = {
  email: string;
  first_name?: string;
  last_name?: string;
  company_name?: string;
  phone_number?: string;
  linkedin_profile?: string;
  custom_fields?: Record<string, string>;
};

/** A contact as Smartlead's lead: standard fields as columns, everything else as custom fields. */
export function leadOf(c: OutboundContact): SmartleadLead {
  const { first, last } = splitName(c.fullName);
  const custom = Object.fromEntries(Object.entries({ ...(c.title ? { title: c.title } : {}), ...c.custom }).map(([k, v]) => [k, String(v)]));
  return {
    email: c.email!.trim(),
    ...(first ? { first_name: first } : {}),
    ...(last ? { last_name: last } : {}),
    ...(c.company ? { company_name: c.company } : {}),
    ...(c.phone ? { phone_number: c.phone } : {}),
    ...(c.linkedinUrl ? { linkedin_profile: c.linkedinUrl } : {}),
    ...(Object.keys(custom).length ? { custom_fields: custom } : {}),
  };
}

const emailOf = (x: unknown) => str(x) ?? str((x as { email?: unknown } | null)?.email);

export function createSmartleadClient(opts: { apiKey: string; fetchImpl?: typeof fetch; baseUrl?: string }): SequencerClient {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const base = (opts.baseUrl ?? SMARTLEAD_BASE_URL).replace(/\/$/, "");
  const call = <T>(method: "GET" | "POST", path: string, body?: unknown) =>
    requestJson<T>("Smartlead", fetchImpl, `${base}${path}${path.includes("?") ? "&" : "?"}api_key=${encodeURIComponent(opts.apiKey)}`, {
      method,
      headers: { "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  async function listCampaigns() {
    const r = await call<unknown>("GET", "/campaigns/");
    const items = Array.isArray(r) ? r : ((r as { campaigns?: unknown[] } | null)?.campaigns ?? []);
    const out: SequencerCampaign[] = [];
    for (const c of items as Array<{ id?: unknown; name?: unknown; status?: unknown }>) {
      const id = idOf(c?.id);
      if (id) out.push({ id, name: str(c.name) ?? id, ...(str(c.status) ? { status: str(c.status) } : {}) });
    }
    return out;
  }
  return {
    async validate() {
      await listCampaigns();
    },
    listCampaigns,
    /** 100 to a request. Smartlead skips a lead already in the campaign or on a block or unsubscribe list. */
    async addLeads(campaignId: string, contacts: readonly OutboundContact[], onBatch?: OnBatch, beforeBatch?: BeforeBatch) {
      const total: AddLeadsResult = { created: [], uploaded: 0 };
      for (let i = 0; i < contacts.length; i += SMARTLEAD_BATCH) {
        const candidates = contacts.slice(i, i + SMARTLEAD_BATCH);
        const batch = beforeBatch ? await beforeBatch(candidates) : candidates;
        if (!batch.length) continue;
        const r = await call<Record<string, unknown>>("POST", `/campaigns/${encodeURIComponent(campaignId)}/leads`, {
          lead_list: batch.map(leadOf),
          settings: { ignore_global_block_list: false, ignore_unsubscribe_list: false, ignore_duplicate_leads_in_other_campaign: false },
        });
        const uploaded = num(r.added_count);
        // Named skips make the rest of the batch the created leads, but only when the count agrees.
        const skipped = Array.isArray(r.skipped_leads) ? new Set(r.skipped_leads.flatMap((l) => (emailOf(l) ? [emailOf(l)!.trim().toLowerCase()] : []))) : null;
        const rest = skipped ? batch.map((c) => c.email!.trim().toLowerCase()).filter((e) => !skipped.has(e)) : [];
        const result: AddLeadsResult = { created: skipped && rest.length === uploaded ? rest : [], uploaded };
        await onBatch?.(batch, result);
        total.created.push(...result.created);
        total.uploaded += result.uploaded;
      }
      return total;
    },
  };
}
