/**
 * The generic signed webhook (docs/connector-feeds.md): an admin adds a link, gets a URL and a signing secret, and
 * any system that can sign a POST (a product's usage events, a form, a check-in app) writes the workspace's
 * `webhook.events` feed. Signed like event agents' webhooks (lib/agents/webhook.ts). Pure and runtime-neutral.
 */
import type { ConnectorDecl } from "./registry.ts";
import { eventKeyOf, subjectOf } from "../agents/webhook.ts";

export const WEBHOOK_FEED = "webhook.events";
export const CONNECTOR_WEBHOOK_PREFIX = "/connectors/webhook/";

export const webhook = {
  id: "webhook",
  label: "Signed webhook",
  scope: "workspace",
  auth: "signedWebhook",
  env: [],
  feeds: {
    [WEBHOOK_FEED]: {
      label: "Webhook events",
      fields: {
        type: { type: "string", label: "Type" },
        occurredAt: { type: "time", label: "Occurred at" },
        subject: { type: "object", label: "Who it is about" },
        data: { type: "object", label: "Data" },
      },
      maxItemBytes: 16_384,
    },
  },
} as const satisfies ConnectorDecl;

/**
 * A signed body as a feed item. `id` (or `event_id`, `eventId`) names it, else the body's hash, so a redelivery is
 * the same item; `version`, a number, orders updates to one id. `subject` is who it is about, as event agents read it.
 */
export async function webhookItem(payload: unknown, body: string): Promise<{ ok: true; id: string; version?: number; data: Record<string, unknown> } | { ok: false; error: string }> {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return { ok: false, error: "The body must be a JSON object." };
  const p = payload as Record<string, unknown>;
  if (typeof p.type !== "string" || !p.type.trim()) return { ok: false, error: "The body needs a type." };
  const occurredAt = typeof p.occurredAt === "number" ? p.occurredAt : typeof p.occurredAt === "string" ? Date.parse(p.occurredAt) : NaN;
  const data = p.data === undefined ? {} : p.data;
  if (typeof data !== "object" || data === null || Array.isArray(data)) return { ok: false, error: "data must be an object." };
  const subject = typeof p.subject === "object" && p.subject !== null && !Array.isArray(p.subject) ? p.subject : {};
  return {
    ok: true,
    id: await eventKeyOf(payload, body),
    ...(typeof p.version === "number" && Number.isFinite(p.version) ? { version: p.version } : {}),
    data: { type: p.type.trim().slice(0, 200), occurredAt: Number.isFinite(occurredAt) ? occurredAt : null, subject: subjectOf({ ...p, ...subject }), data },
  };
}
