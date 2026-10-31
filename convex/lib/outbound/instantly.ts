/**
 * Instantly (API v2) adapter: list campaigns and add leads to one, with the
 * workspace's own API key. The key goes only in the Authorization header.
 *
 * Pure: no database access, no Node-only imports.
 */
import { splitName, type OutboundContact } from "./audience.ts";
import { idOf, num, requestJson, str, type AddLeadsResult, type BeforeBatch, type OnBatch, type SequencerCampaign, type SequencerClient } from "./client.ts";

export const INSTANTLY_BASE_URL = "https://api.instantly.ai";
/** Instantly accepts 1 to 1000 leads per bulk request. */
export const INSTANTLY_BATCH = 1000;
const CAMPAIGN_PAGES_MAX = 5;

export type InstantlyLead = {
  email: string;
  first_name?: string;
  last_name?: string;
  company_name?: string;
  job_title?: string;
  phone?: string;
  custom_variables?: Record<string, string | number | boolean>;
};

/** A contact as Instantly's lead: standard fields as columns, everything else as custom variables. */
export function leadOf(c: OutboundContact): InstantlyLead {
  const { first, last } = splitName(c.fullName);
  const custom: Record<string, string | number | boolean> = { ...(c.linkedinUrl ? { linkedin_url: c.linkedinUrl } : {}), ...c.custom };
  return {
    email: c.email!.trim(),
    ...(first ? { first_name: first } : {}),
    ...(last ? { last_name: last } : {}),
    ...(c.company ? { company_name: c.company } : {}),
    ...(c.title ? { job_title: c.title } : {}),
    ...(c.phone ? { phone: c.phone } : {}),
    ...(Object.keys(custom).length ? { custom_variables: custom } : {}),
  };
}

export function createInstantlyClient(opts: { apiKey: string; fetchImpl?: typeof fetch; baseUrl?: string }): SequencerClient {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const base = (opts.baseUrl ?? INSTANTLY_BASE_URL).replace(/\/$/, "");
  const call = <T>(method: "GET" | "POST", path: string, body?: unknown) =>
    requestJson<T>("Instantly", fetchImpl, `${base}${path}`, {
      method,
      headers: { Authorization: `Bearer ${opts.apiKey}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return {
    async validate() {
      await call("GET", "/api/v2/campaigns?limit=1");
    },
    async listCampaigns() {
      const out: SequencerCampaign[] = [];
      let after: string | undefined;
      for (let page = 0; page < CAMPAIGN_PAGES_MAX; page++) {
        const r = await call<{ items?: Array<{ id?: unknown; name?: unknown; status?: unknown }>; next_starting_after?: unknown }>(
          "GET",
          `/api/v2/campaigns?limit=100${after ? `&starting_after=${encodeURIComponent(after)}` : ""}`,
        );
        for (const c of r.items ?? []) {
          const id = idOf(c.id);
          if (id) out.push({ id, name: str(c.name) ?? id, ...(typeof c.status === "number" ? { status: String(c.status) } : {}) });
        }
        after = str(r.next_starting_after);
        if (!after) break;
      }
      return out;
    },
    /** 1000 to a request. Instantly is asked to skip a lead already in the campaign, so a repeated call adds nothing twice. */
    async addLeads(campaignId: string, contacts: readonly OutboundContact[], onBatch?: OnBatch, beforeBatch?: BeforeBatch) {
      const total: AddLeadsResult = { created: [], uploaded: 0 };
      for (let i = 0; i < contacts.length; i += INSTANTLY_BATCH) {
        const candidates = contacts.slice(i, i + INSTANTLY_BATCH);
        const batch = beforeBatch ? await beforeBatch(candidates) : candidates;
        if (!batch.length) continue;
        const r = await call<Record<string, unknown>>("POST", "/api/v2/leads/add", {
          campaign_id: campaignId,
          leads: batch.map(leadOf),
          skip_if_in_campaign: true,
          verify_leads_on_import: false,
        });
        const created = Array.isArray(r.created_leads) ? r.created_leads.flatMap((l) => (str((l as { email?: unknown })?.email) ? [(l as { email: string }).email.trim().toLowerCase()] : [])) : [];
        const result: AddLeadsResult = { created, uploaded: num(r.leads_uploaded) };
        await onBatch?.(batch, result);
        total.created.push(...created);
        total.uploaded += result.uploaded;
      }
      return total;
    },
  };
}
