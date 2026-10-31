import { api } from "../../../../../../convex/_generated/api.js";
import { publicGtmApi, readJsonBody } from "../../../gtm/_lib.ts";
import { agentTokenRejection } from "../../../agents/_lib.ts";
import { bearerToken, invalidCliTokenResponse, plainConvexClient } from "../../_lib.ts";

const MAX_BODY_BYTES = 750_000;
const MAX_FACTS = 500;
const AGENT_SOURCES = new Set(["agent_run", "enrichment", "call", "pipeline"]);

function auth(request: Request): { token: string } | { response: Response } {
  const token = bearerToken(request);
  const rejection = agentTokenRejection(token, request);
  if (rejection) return { response: rejection };
  if (!token?.startsWith("fsgtm_")) return { response: Response.json({ error: "Missing CLI token" }, { status: 401 }) };
  return { token };
}

const str = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
const opt = (value: unknown, max: number) => value === undefined || str(value, max);

const ENTITY_TYPES = new Set(["opportunity", "account", "contact"]);

/** Each fact names its record: a deal by id, a CRM row, or (accounts/contacts) an entity, record id, domain or email. */
function hasTarget(f: Record<string, unknown>): boolean {
  const crm = f.crmProvider !== undefined && f.crmId !== undefined;
  const type = f.entityType ?? "opportunity";
  if (type === "opportunity") return f.dealId !== undefined || crm;
  const byKey = type === "account" ? f.accountId ?? f.domain : f.contactId ?? f.email;
  return crm || byKey !== undefined || f.entityId !== undefined || f.recordId !== undefined;
}

function validFact(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const f = value as Record<string, unknown>;
  const scalar = f.value === null || typeof f.value === "boolean" || (typeof f.value === "number" && Number.isFinite(f.value)) || (typeof f.value === "string" && f.value.length <= 10_000);
  return scalar && str(f.attribute, 100) && opt(f.dealId, 100) && opt(f.crmId, 200) &&
    (f.entityType === undefined || ENTITY_TYPES.has(f.entityType as string)) &&
    opt(f.accountId, 100) && opt(f.contactId, 100) && opt(f.entityId, 100) && opt(f.recordId, 200) && opt(f.domain, 300) && opt(f.email, 320) &&
    (f.crmProvider === undefined || f.crmProvider === "salesforce" || f.crmProvider === "hubspot") &&
    hasTarget(f) &&
    opt(f.evidence, 4_000) && (f.confidence === undefined || (typeof f.confidence === "number" && f.confidence >= 0 && f.confidence <= 1)) &&
    (f.validFrom === undefined || (typeof f.validFrom === "number" && Number.isSafeInteger(f.validFrom)));
}

const FACT_KEYS = [
  "entityType", "dealId", "accountId", "contactId", "crmProvider", "crmId", "entityId", "recordId", "domain", "email",
  "attribute", "value", "evidence", "confidence", "validFrom",
];
const pick = (f: Record<string, unknown>) => Object.fromEntries(FACT_KEYS.filter((k) => f[k] !== undefined).map((k) => [k, f[k]]));

/** Batch status: GET ?patchPlanId= */
export const GET = publicGtmApi(async (request) => {
  const authorized = auth(request);
  if ("response" in authorized) return authorized.response;
  const patchPlanId = new URL(request.url).searchParams.get("patchPlanId");
  if (!str(patchPlanId, 100)) return Response.json({ error: "patchPlanId is required" }, { status: 400 });
  try {
    const result = await plainConvexClient().action(api.canonGateActions.status, { cliToken: authorized.token, patchPlanId });
    if (!result) return Response.json({ error: "Batch not found" }, { status: 404 });
    return Response.json(result);
  } catch (error) {
    const unauthorized = invalidCliTokenResponse(error);
    if (unauthorized) return unauthorized;
    throw error;
  }
});

/** Submit a batch of proposed facts. */
export const POST = publicGtmApi(async (request) => {
  const authorized = auth(request);
  if ("response" in authorized) return authorized.response;
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) return Response.json({ error: "Batch is too large" }, { status: 413 });
  const body = await readJsonBody(request);
  if (JSON.stringify(body).length > MAX_BODY_BYTES) return Response.json({ error: "Batch is too large" }, { status: 413 });
  if (!str(body.agentId, 200) || !str(body.title, 200) || !opt(body.reason, 2_000)) return Response.json({ error: "agentId and title are required" }, { status: 400 });
  if (typeof body.sourceKind !== "string" || !AGENT_SOURCES.has(body.sourceKind)) return Response.json({ error: "sourceKind must be agent_run, enrichment, call or pipeline" }, { status: 400 });
  if (!Array.isArray(body.facts) || !body.facts.length || body.facts.length > MAX_FACTS) return Response.json({ error: `facts must hold 1-${MAX_FACTS} items` }, { status: 400 });
  const bad = body.facts.findIndex((f) => !validFact(f));
  if (bad >= 0) return Response.json({ error: `facts[${bad}] is invalid` }, { status: 400 });
  try {
    return Response.json(await plainConvexClient().action(api.canonGateActions.submit, {
      cliToken: authorized.token, agentId: body.agentId, title: body.title, reason: body.reason as string | undefined,
      sourceKind: body.sourceKind as "agent_run" | "enrichment" | "call" | "pipeline",
      facts: body.facts.map((f) => pick(f as Record<string, unknown>)) as never,
    }));
  } catch (error) {
    const unauthorized = invalidCliTokenResponse(error);
    if (unauthorized) return unauthorized;
    throw error;
  }
});
