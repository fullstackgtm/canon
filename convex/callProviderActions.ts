"use node";

import { can, refusal } from "./lib/capabilities";
import { ConvexError, v } from "convex/values";
import { action, internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { decryptFromStorage } from "./lib/tokenHelpers";
import {
  CALL_SYNC_STAGES,
  nullProgressEmitter,
  type ProgressEmitter,
} from "../engine/src/progress.ts";
import { syncRunProgressEmitter } from "./lib/syncRunProgress";
import { activeClerkOrgIdFromIdentity } from "./lib";
import { fetchAvomaCalls, normalizeAvomaCall } from "./lib/calls/avoma";

const callProviderValidator = v.union(
  v.literal("gong"),
  v.literal("chorus"),
  v.literal("fathom"),
  v.literal("avoma"),
  v.literal("granola"),
);

type CallProvider = "gong" | "chorus" | "fathom" | "avoma" | "granola";

type NormalizedProviderCall = {
  externalCallId?: string;
  title: string;
  callDate?: string;
  durationSeconds?: number;
  recordingUrl?: string;
  participants?: Array<Record<string, unknown>>;
  transcriptText: string;
  sourceMetadata?: Record<string, unknown>;
  segments?: Array<{ side: "rep" | "customer"; startSeconds: number | null; endSeconds: number | null }>;
};

export const syncProvider = action({
  args: { provider: callProviderValidator },
  handler: async (ctx, args): Promise<{ calls: number; insights: number }> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new ConvexError("Not authenticated");

    const user = await ctx.runQuery(internal.callProviders.getUserByClerkId, {
      clerkUserId: identity.subject,
      activeClerkOrgId: activeClerkOrgIdFromIdentity(identity) ?? undefined,
    });
    if (!user) throw new ConvexError("User not found");
    if (!can(user, "integrations.manage")) throw new ConvexError(refusal("integrations.manage"));

    return syncProviderForOrg(ctx, user.orgId, args.provider, "manual");
  },
});

export const syncProviderInternal = internalAction({
  args: {
    orgId: v.id("organizations"),
    provider: callProviderValidator,
    trigger: v.union(
      v.literal("manual"),
      v.literal("scheduled"),
      v.literal("oauth"),
      v.literal("system"),
    ),
  },
  handler: async (ctx, args): Promise<{ calls: number; insights: number }> => {
    return syncProviderForOrg(ctx, args.orgId, args.provider, args.trigger);
  },
});

async function syncProviderForOrg(
  ctx: any,
  orgId: Id<"organizations">,
  provider: CallProvider,
  trigger: "manual" | "scheduled" | "oauth" | "system",
): Promise<{ calls: number; insights: number }> {
  // Granola has its own poll: it matches each meeting to its people, company and deal (convex/granolaActions.ts).
  if (provider === "granola") {
    return ctx.runAction(internal.granolaActions.syncOrg, { orgId, trigger });
  }
  const syncRunId: Id<"integrationSyncRuns"> = await ctx.runMutation(
    internal.integrations.startSyncRun,
    { orgId, provider, trigger },
  );

  await ctx.runMutation(internal.callProviders.updateSyncStatus, {
    orgId,
    provider,
    status: "in_progress",
  });

  // Shared progress vocabulary (CALL_SYNC_STAGES): notes listed → per-note
  // transcripts → insights. Heartbeats are fire-and-forget (see
  // syncRunProgressEmitter) and can never fail the sync.
  const progress = syncRunProgressEmitter(ctx, syncRunId);

  try {
    const integration = await ctx.runQuery(internal.callProviders.getIntegration, {
      orgId,
      provider,
    });
    if (!integration || !integration.isActive) {
      throw new ConvexError(`No active ${providerLabel(provider)} integration`);
    }

    progress.stage(CALL_SYNC_STAGES[0], 0, CALL_SYNC_STAGES.length); // notes
    const calls = await fetchProviderCalls(integration, provider, progress);
    let insights = 0;
    let imported = 0;

    progress.stage(CALL_SYNC_STAGES[2], 2, CALL_SYNC_STAGES.length); // insights
    let processed = 0;
    for (const call of calls) {
      processed += 1;
      progress.items(processed, calls.length);
      if (!call.transcriptText.trim()) continue;
      const result: { callId: Id<"callRecordings"> } = await ctx.runMutation(
        internal.callIntelligence.importProviderTranscript,
        {
          orgId,
          provider,
          externalCallId: call.externalCallId,
          title: call.title,
          callDate: call.callDate,
          durationSeconds: call.durationSeconds,
          recordingUrl: call.recordingUrl,
          participants: call.participants,
          transcriptText: call.transcriptText,
          sourceMetadata: call.sourceMetadata,
          segments: call.segments,
        },
      );
      const analysis: { insights: number } = await ctx.runMutation(
        internal.callIntelligence.analyzeImportedCall,
        { orgId, callId: result.callId },
      );
      insights += analysis.insights;
      imported += 1;
    }
    progress.flush();

    await ctx.runMutation(internal.integrations.finishSyncRun, {
      syncRunId,
      status: "success",
      counts: { calls: imported, insights },
    });
    await ctx.runMutation(internal.callProviders.updateSyncStatus, {
      orgId,
      provider,
      status: "success",
      callCount: imported,
    });

    return { calls: imported, insights };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Call provider sync failed";
    await ctx.runMutation(internal.integrations.finishSyncRun, {
      syncRunId,
      status: "error",
      counts: { calls: 0, insights: 0 },
      error: message,
    });
    await ctx.runMutation(internal.callProviders.updateSyncStatus, {
      orgId,
      provider,
      status: "error",
      error: message,
      callCount: 0,
    });
    throw error;
  }
}

async function fetchProviderCalls(
  integration: any,
  provider: CallProvider,
  progress: ProgressEmitter = nullProgressEmitter(),
): Promise<NormalizedProviderCall[]> {
  const syncConfig = integration.syncConfig ?? {};
  if (Array.isArray(syncConfig.sampleCalls)) {
    return syncConfig.sampleCalls.map((call: unknown) => normalizeCall(call, provider));
  }

  const baseUrl = String(integration.instanceUrl ?? "").replace(/\/$/, "");
  const callsPath = String(syncConfig.callsPath ?? "");
  if (!baseUrl || !callsPath) {
    throw new ConvexError(`${providerLabel(provider)} base URL and calls path are required`);
  }

  const apiKey = await decryptFromStorage(integration.accessToken);
  const apiSecret = integration.refreshToken
    ? await decryptFromStorage(integration.refreshToken)
    : "";
  if (!apiKey) throw new ConvexError(`${providerLabel(provider)} API key is required`);

  if (provider === "avoma") return fetchAvomaCalls({ apiKey, baseUrl, callsPath, progress });

  const response = await fetch(`${baseUrl}${callsPath}`, {
    method: "GET",
    headers: authHeaders(provider, apiKey, apiSecret),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new ConvexError(`${providerLabel(provider)} API error ${response.status}: ${body}`);
  }

  const payload = await response.json();
  const rawCalls = Array.isArray(payload)
    ? payload
    : payload.calls ?? payload.results ?? payload.data ?? [];
  if (!Array.isArray(rawCalls)) {
    throw new ConvexError(`${providerLabel(provider)} response did not include a calls array`);
  }

  // These providers return transcripts in the same payload — the stage is
  // instantaneous but still emitted so the timeline reads the same everywhere.
  progress.stage(CALL_SYNC_STAGES[1], 1, CALL_SYNC_STAGES.length); // transcripts
  progress.items(rawCalls.length, rawCalls.length);
  return rawCalls.map((call: unknown) => normalizeCall(call, provider));
}

function authHeaders(provider: CallProvider, apiKey: string, apiSecret: string) {
  if (provider === "gong" && apiSecret) {
    return {
      Authorization: `Basic ${Buffer.from(`${apiKey}:${apiSecret}`).toString("base64")}`,
      Accept: "application/json",
    };
  }
  return {
    Authorization: `Bearer ${apiKey}`,
    Accept: "application/json",
  };
}

function normalizeCall(raw: unknown, provider: CallProvider): NormalizedProviderCall {
  const call = isRecord(raw) ? raw : {};
  if (provider === "avoma") return normalizeAvomaCall(call.meeting, call.transcription, call.recording);
  const transcript = transcriptText(call);
  return {
    externalCallId: stringValue(call.id ?? call.callId ?? call.externalCallId),
    title:
      stringValue(call.title ?? call.name ?? call.subject) ??
      `${providerLabel(provider)} call`,
    callDate: stringValue(call.startedAt ?? call.startTime ?? call.callDate ?? call.date),
    durationSeconds: numberValue(call.durationSeconds ?? call.duration ?? call.duration_sec),
    recordingUrl: stringValue(call.recordingUrl ?? call.url ?? call.mediaUrl),
    participants: Array.isArray(call.participants) ? call.participants as Array<Record<string, unknown>> : undefined,
    transcriptText: transcript,
    sourceMetadata: { provider, raw },
  };
}

function transcriptText(call: Record<string, unknown>) {
  if (typeof call.transcriptText === "string") return call.transcriptText;
  if (typeof call.transcript === "string") return call.transcript;
  if (Array.isArray(call.transcript)) {
    return call.transcript
      .map((segment) => {
        if (!isRecord(segment)) return String(segment);
        const speaker = stringValue(segment.speaker ?? segment.speakerName ?? segment.role);
        const text = stringValue(segment.text ?? segment.content ?? segment.sentence) ?? "";
        return speaker ? `${speaker}: ${text}` : text;
      })
      .filter(Boolean)
      .join("\n");
  }
  if (Array.isArray(call.segments)) {
    return call.segments
      .map((segment) => {
        if (!isRecord(segment)) return String(segment);
        const speaker = stringValue(segment.speaker ?? segment.speakerName ?? segment.role);
        const text = stringValue(segment.text ?? segment.content ?? segment.sentence) ?? "";
        return speaker ? `${speaker}: ${text}` : text;
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function providerLabel(provider: CallProvider) {
  if (provider === "gong") return "Gong";
  if (provider === "chorus") return "Chorus";
  if (provider === "granola") return "Granola";
  if (provider === "avoma") return "Avoma";
  return "Fathom";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown) {
  if (value === undefined || value === null || value === "") return undefined;
  return String(value);
}

function numberValue(value: unknown) {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
