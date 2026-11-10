/**
 * EmailBison adapter: list campaigns and add leads to one, with the
 * workspace's own API token on its own EmailBison host (each customer has one).
 * The token goes only in the Authorization header.
 *
 * Pure: no database access, no Node-only imports.
 */
import { splitName, type OutboundContact } from "./audience.ts";
import { idOf, requestJson, str, type AddLeadsResult, type BeforeBatch, type OnBatch, type SequencerCampaign, type SequencerClient } from "./client.ts";

/** EmailBison takes at most 500 leads per bulk request. */
export const EMAILBISON_BATCH = 500;
const CAMPAIGN_PAGES_MAX = 20;

export type EmailBisonLead = {
  email: string;
  first_name: string;
  last_name?: string;
  title?: string;
  company?: string;
  custom_variables?: Array<{ name: string; value: string }>;
};

/** EmailBison refuses a lead without a first name; the registry keeps those out of the push. */
export const hasFirstName = (c: OutboundContact) => Boolean(splitName(c.fullName).first);

/** A contact as EmailBison's lead. Phone and LinkedIn have no column there, so they travel as custom variables. */
export function leadOf(c: OutboundContact): EmailBisonLead {
  const { first, last } = splitName(c.fullName);
  const custom: Record<string, string | number | boolean> = { ...(c.phone ? { phone: c.phone } : {}), ...(c.linkedinUrl ? { linkedin_url: c.linkedinUrl } : {}), ...c.custom };
  const vars = Object.entries(custom).map(([name, value]) => ({ name, value: String(value) }));
  return {
    email: c.email!.trim(),
    first_name: first,
    ...(last ? { last_name: last } : {}),
    ...(c.title ? { title: c.title } : {}),
    ...(c.company ? { company: c.company } : {}),
    ...(vars.length ? { custom_variables: vars } : {}),
  };
}

export function createEmailBisonClient(opts: { apiKey: string; baseUrl: string; fetchImpl?: typeof fetch }): SequencerClient {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const base = opts.baseUrl.replace(/\/$/, "");
  const call = <T>(method: "GET" | "POST", path: string, body?: unknown) =>
    requestJson<T>("EmailBison", fetchImpl, `${base}${path}`, {
      method,
      headers: { Authorization: `Bearer ${opts.apiKey}`, "Content-Type": "application/json", Accept: "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return {
    async validate() {
      await call("GET", "/api/users");
    },
    async listCampaigns() {
      const out: SequencerCampaign[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < CAMPAIGN_PAGES_MAX; page++) {
        const r = await call<{ data?: Array<{ id?: unknown; name?: unknown; status?: unknown }>; meta?: { next_cursor?: unknown } }>(
          "GET",
          `/api/campaigns?pagination_type=cursor${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
        );
        for (const c of r.data ?? []) {
          const id = idOf(c.id);
          if (id) out.push({ id, name: str(c.name) ?? id, ...(str(c.status) ? { status: str(c.status) } : {}) });
        }
        cursor = str(r.meta?.next_cursor);
        if (!cursor) break;
      }
      return out;
    },
    /**
     * 500 to a request: create the leads (or update the ones the workspace already has, keeping fields
     * Canon does not send), then attach them to the campaign by id.
     */
    async addLeads(campaignId: string, contacts: readonly OutboundContact[], onBatch?: OnBatch, beforeBatch?: BeforeBatch) {
      const total: AddLeadsResult = { created: [], uploaded: 0 };
      for (let i = 0; i < contacts.length; i += EMAILBISON_BATCH) {
        const candidates = contacts.slice(i, i + EMAILBISON_BATCH);
        const batch = beforeBatch ? await beforeBatch(candidates) : candidates;
        if (!batch.length) continue;
        const r = await call<{ data?: Array<{ id?: unknown; email?: unknown }> }>("POST", "/api/leads/create-or-update/multiple", {
          existing_lead_behavior: "patch",
          leads: batch.map(leadOf),
        });
        const saved = (r.data ?? []).flatMap((l) => {
          const id = typeof l?.id === "number" ? l.id : undefined;
          const email = str(l?.email);
          return id !== undefined && email ? [{ id, email: email.trim().toLowerCase() }] : [];
        });
        const attach = beforeBatch ? new Set((await beforeBatch(batch)).map((c) => c.email!.trim().toLowerCase())) : new Set(saved.map((l) => l.email));
        const allowed = saved.filter((l) => attach.has(l.email));
        if (allowed.length) await call("POST", `/api/campaigns/${encodeURIComponent(campaignId)}/leads/attach-leads`, { lead_ids: allowed.map((l) => l.id) });
        const result: AddLeadsResult = { created: allowed.map((l) => l.email), uploaded: allowed.length };
        await onBatch?.(batch.filter((c) => attach.has(c.email!.trim().toLowerCase())), result);
        total.created.push(...result.created);
        total.uploaded += result.uploaded;
      }
      return total;
    },
  };
}
