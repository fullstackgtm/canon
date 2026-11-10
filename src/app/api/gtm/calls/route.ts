import { api } from "../../../../../convex/_generated/api";
import type { Id } from "../../../../../convex/_generated/dataModel";
import { apiErrorResponse, gtmApi, readJsonBody, unsupportedAction } from "../_lib";

export const dynamic = "force-dynamic";

export const GET = gtmApi(async ({ client, url }) => {
  const callId = url.searchParams.get("callId");
  if (callId) {
    const call = await client.query(api.callIntelligence.getCall, {
      callId: callId as Id<"callRecordings">,
    });
    return Response.json({ call });
  }

  const [summary, calls, insights] = await Promise.all([
    client.query(api.callIntelligence.summary, {}),
    client.query(api.callIntelligence.listCalls, { limit: 100 }),
    client.query(api.callIntelligence.listInsights, { limit: 100 }),
  ]);
  return Response.json({ summary, calls, insights });
});

export const POST = gtmApi(async ({ client, request }) => {
  const body = await readJsonBody(request);
  const action = typeof body.action === "string" ? body.action : "ingestAndAnalyze";

  if (action === "analyze") {
    if (typeof body.callId !== "string") {
      return apiErrorResponse("USER_INPUT", "callId is required", ["Pass callId when action is analyze."]);
    }
    const result = await client.mutation(api.callIntelligence.analyzeCall, {
      callId: body.callId as Id<"callRecordings">,
    });
    return Response.json(result);
  }

  if (action === "syncProvider") {
    const provider = body.provider;
    if (provider !== "gong" && provider !== "chorus" && provider !== "fathom" && provider !== "avoma" && provider !== "granola") {
      return apiErrorResponse("USER_INPUT", "provider must be gong, chorus, fathom, avoma or granola", ["Pass the call provider to sync."]);
    }
    return Response.json(await client.action(api.callProviderActions.syncProvider, { provider }));
  }

  if (action === "ingestAndAnalyzeDemo") {
    const result = await client.mutation(api.callIntelligence.ingestAndAnalyzeDemo, {});
    return Response.json(result);
  }

  if (action === "proposeDealNextStepPatchPlan") {
    if (typeof body.insightId !== "string") {
      return apiErrorResponse("USER_INPUT", "insightId is required", ["Pass insightId when action is proposeDealNextStepPatchPlan."]);
    }
    const result = await client.mutation(api.callIntelligence.proposeDealNextStepPatchPlan, {
      insightId: body.insightId as Id<"callInsights">,
      nextStep: typeof body.nextStep === "string" ? body.nextStep : undefined,
    });
    return Response.json(result);
  }

  if (action !== "ingestAndAnalyze" && action !== "ingest") {
    return unsupportedAction();
  }

  if (typeof body.title !== "string" || typeof body.transcriptText !== "string") {
    return apiErrorResponse("USER_INPUT", "title and transcriptText are required", ["Pass both title and transcriptText for call transcript ingestion."]);
  }

  const created = await client.mutation(api.callIntelligence.ingestTranscript, {
    provider: normalizeProvider(body.provider),
    externalCallId: typeof body.externalCallId === "string" ? body.externalCallId : undefined,
    title: body.title,
    callDate: typeof body.callDate === "string" ? body.callDate : undefined,
    durationSeconds:
      typeof body.durationSeconds === "number" ? body.durationSeconds : undefined,
    recordingUrl: typeof body.recordingUrl === "string" ? body.recordingUrl : undefined,
    transcriptText: body.transcriptText,
  });

  if (action === "ingest") return Response.json(created);

  const analysis = await client.mutation(api.callIntelligence.analyzeCall, {
    callId: created.callId,
  });
  return Response.json({ ...created, analysis });
});

function normalizeProvider(provider: unknown) {
  if (
    provider === "gong" ||
    provider === "chorus" ||
    provider === "fathom" ||
    provider === "avoma" ||
    provider === "salesforce" ||
    provider === "hubspot" ||
    provider === "csv" ||
    provider === "manual" ||
    provider === "custom"
  ) {
    return provider;
  }
  return "manual";
}
