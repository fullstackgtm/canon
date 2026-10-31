import { api } from "../../../../../convex/_generated/api.js";
import { publicGtmApi, readJsonBody } from "../../gtm/_lib.ts";
import { bearerToken, invalidCliTokenResponse, plainConvexClient } from "../_lib.ts";
import { agentTokenRejection } from "../../agents/_lib.ts";

/**
 * Observability ingest: the CLI POSTs a run record here after a command, using
 * the broker token from `login --via`. Pull-only auth reused — org/user are
 * resolved server-side from the token. Reporting is opt-in (the CLI only calls
 * this when a broker credential exists) and never required for the CLI to work.
 */
export const POST = publicGtmApi(async (request) => {
  const cliToken = bearerToken(request);
  // Self-registered agent tokens share the fsgtm_ prefix family but are a
  // lower tier: public reads only. Teach the upgrade path instead of letting
  // them fall through to a confusing "invalid CLI token" 401.
  const rejection = agentTokenRejection(cliToken, request);
  if (rejection) return rejection;
  if (!cliToken?.startsWith("fsgtm_")) {
    return Response.json({ error: "Missing CLI token" }, { status: 401 });
  }
  const body = await readJsonBody(request);
  const { command, status } = body;
  // "in_progress" = a live-streaming heartbeat: the CLI re-POSTs the same
  // clientRunId as the run advances, and the terminal report (success/
  // partial/error) upserts the same row (convex/cliRuns.insertRun).
  if (
    typeof command !== "string" ||
    (status !== "success" &&
      status !== "partial" &&
      status !== "error" &&
      status !== "in_progress")
  ) {
    return Response.json({ error: "command and status are required" }, { status: 400 });
  }
  if (
    typeof body.startedAt !== "number" ||
    typeof body.finishedAt !== "number" ||
    typeof body.durationMs !== "number"
  ) {
    return Response.json(
      { error: "startedAt, finishedAt and durationMs must be numbers" },
      { status: 400 },
    );
  }
  const optString = (value: unknown): string | undefined =>
    typeof value === "string" ? value : undefined;
  const events = Array.isArray(body.events)
    ? body.events.flatMap((raw) => {
        if (raw && typeof raw === "object") {
          const ev = raw as Record<string, unknown>;
          if (typeof ev.ts === "number" && typeof ev.type === "string") {
            return [{ ts: ev.ts, type: ev.type, detail: optString(ev.detail) }];
          }
        }
        return [];
      })
    : undefined;
  // Per-row audit findings: IDs + issue type only. Sanitized + capped here so a
  // malformed or oversized client payload can't bloat the run record.
  const findings = Array.isArray(body.findings)
    ? body.findings.flatMap((raw) => {
        if (raw && typeof raw === "object") {
          const f = raw as Record<string, unknown>;
          if (
            typeof f.objectType === "string" &&
            typeof f.objectId === "string" &&
            typeof f.severity === "string" &&
            typeof f.ruleId === "string"
          ) {
            return [
              {
                objectType: f.objectType,
                objectId: f.objectId,
                severity: f.severity,
                ruleId: f.ruleId,
                field: optString(f.field),
                operation: optString(f.operation),
              },
            ];
          }
        }
        return [];
      }).slice(0, 2000)
    : undefined;
  // Live-progress heartbeat payload (shared progress vocabulary). Sanitized
  // field-by-field: numbers must be finite numbers, strings are length-capped,
  // and anything malformed is dropped rather than rejected — a bad heartbeat
  // must never break run reporting. heartbeatAt defaults to the server clock.
  const optNumber = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isFinite(value) ? value : undefined;
  const progressRaw = body.progress as Record<string, unknown> | undefined;
  const progress =
    progressRaw && typeof progressRaw === "object" && !Array.isArray(progressRaw)
      ? {
          stage:
            typeof progressRaw.stage === "string"
              ? progressRaw.stage.slice(0, 100)
              : undefined,
          stageIndex: optNumber(progressRaw.stageIndex),
          stageCount: optNumber(progressRaw.stageCount),
          itemsDone: optNumber(progressRaw.itemsDone),
          itemsTotal: optNumber(progressRaw.itemsTotal),
          note:
            typeof progressRaw.note === "string"
              ? progressRaw.note.slice(0, 200)
              : undefined,
          heartbeatAt: optNumber(progressRaw.heartbeatAt) ?? Date.now(),
        }
      : undefined;
  // Source-CRM record-URL base for dashboard deep-links (provider + URL prefix).
  const crmRaw = body.crm as Record<string, unknown> | undefined;
  const crm =
    crmRaw &&
    typeof crmRaw === "object" &&
    typeof crmRaw.provider === "string" &&
    typeof crmRaw.recordUrlBase === "string"
      ? { provider: crmRaw.provider, recordUrlBase: crmRaw.recordUrlBase }
      : undefined;
  try {
    const client = plainConvexClient();
    const result = await client.action(api.cliRunsActions.recordRun, {
      cliToken,
      command,
      clientRunId: optString(body.clientRunId),
      status,
      profile: optString(body.profile),
      cliVersion: optString(body.cliVersion),
      startedAt: body.startedAt,
      finishedAt: body.finishedAt,
      durationMs: body.durationMs,
      counts: body.counts,
      findings,
      crm,
      events,
      error: optString(body.error),
      progress,
    });
    return Response.json(result);
  } catch (error) {
    const unauthorized = invalidCliTokenResponse(error);
    if (unauthorized) return unauthorized;
    throw error;
  }
});
