import { ConvexError } from "convex/values";
import type { ModuleScope } from "../modules/scope";
import { canonicalJson } from "../../../modules/kernel/integrity.ts";
import type { VariableSample, VariableTemplate } from "./variables";

export type SequenceVariablePlan = {
  orgId: string; userId: string; sequenceKey: string; version: number;
  templates: Array<VariableTemplate & { step: number; variant: string }>;
  recipients: Array<{ key: string; version: number; contactId: string; name: string }>;
  senders: Array<{ name: string; address: string }>;
  usesEmail: boolean;
};
export type SequencePreflight = { recipients: number; samples: Array<{ key: string; name: string; messages: Array<VariableSample & { step: number; variant: string }> }>; failures: Array<{ key: string; version: number; name: string; problems: string[] }>; ready: boolean; token: string | null };
const text = (v: unknown) => typeof v === "string" ? v : "";
export async function readSequenceVariablePlan(scope: Pick<ModuleScope, "orgId" | "moduleId" | "userId" | "peek" | "view">, key: string, senders: SequenceVariablePlan["senders"]): Promise<SequenceVariablePlan> {
  if (scope.moduleId !== "@canon/sequences" || !scope.userId) throw new ConvexError("Open an installed sequence as a workspace member.");
  const sequence = await scope.peek("sequences", key), steps = await scope.view("steps.forSequence", { sequence: key }), enrollments = await scope.view("enrollments.forSequence", { sequence: key });
  if (!sequence || !Array.isArray(steps) || !Array.isArray(enrollments) || enrollments.length >= 1000) throw new ConvexError("The complete sequence review is unavailable or exceeds 999 recipients.");
  const templates = steps.sort((a, b) => Number(a.data.position) - Number(b.data.position)).flatMap((s, i) => Array.isArray(s.data.variants) ? s.data.variants.flatMap((v: Record<string, unknown>) => v.paused === true ? [] : [{ step: i + 1, variant: text(v.id), subject: text(v.subject), body: text(v.body) }]) : []);
  return { orgId: scope.orgId, userId: scope.userId, sequenceKey: key, version: sequence.version, templates, senders,
    recipients: enrollments.filter((e) => e.data.state !== "finished").map((e) => ({ key: e.key, version: e.version, contactId: text(e.data.contact), name: text(e.data.contactName) || "Recipient" })),
    usesEmail: steps.some((s) => s.data.kind === "auto_email" || s.data.kind === "manual_email") };
}
const bytes = (s: string) => new TextEncoder().encode(s);
async function signingKey() {
  const secret = process.env.RECORD_SERVICE_TOKEN ?? process.env.TOKEN_ENCRYPTION_KEY;
  if (!secret) throw new ConvexError("Sequence review signing is unavailable.");
  return crypto.subtle.importKey("raw", bytes(`canon.sequence-variable-review.v1:${process.env.CONVEX_SITE_URL ?? ""}:${secret}`), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}
export async function signVariableReview(plan: SequenceVariablePlan): Promise<string> {
  const payload = JSON.stringify({ plan: await planHash(plan), expiresAt: Date.now() + 120_000 });
  const signature = [...new Uint8Array(await crypto.subtle.sign("HMAC", await signingKey(), bytes(payload)))].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${payload}.${signature}`;
}
const planHash = async (plan: SequenceVariablePlan) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes(canonicalJson(plan))))].map((b) => b.toString(16).padStart(2, "0")).join("");
export async function requireVariableReview(plan: SequenceVariablePlan, token?: string): Promise<void> {
  if (!plan.recipients.length) return;
  if (token && token.length < 1000) {
    const split = token.lastIndexOf("."), payload = token.slice(0, split), signature = token.slice(split + 1);
    try {
      const parsed = JSON.parse(payload);
      if (/^[a-f0-9]{64}$/.test(signature) && parsed.plan === await planHash(plan) && parsed.expiresAt >= Date.now() && parsed.expiresAt <= Date.now() + 120_000
        && await crypto.subtle.verify("HMAC", await signingKey(), Uint8Array.from(signature.match(/../g)!, (b) => parseInt(b, 16)), bytes(payload))) return;
    } catch { /* A malformed or expired review is refused below. */ }
  }
  throw new ConvexError("Approval refused. Review every recipient's variables, fix failures or exclude them, then approve within two minutes.");
}
