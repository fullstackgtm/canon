import { ConvexError } from "convex/values";
import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import { getCurrentUser } from "../../lib";
import { accessFor, roleIn } from "../../permissions";
import { canonicalJson } from "../../../modules/kernel/integrity.ts";
import { moduleScope, projectSq1Lifecycle, sq1ProjectionDoc, type ModuleScope } from "../modules/scope";
import { installedModule, isEnabled, manifestOf } from "../modules/packages";
import { senderReader } from "../modules/senders";
import { sq1Launches, SQ1_MAX_LAUNCHES, type Sq1Projection } from "./bindings";
import { plan, localDate } from "../../../modules/examples/sequences/engine.ts";
import { requireVariableReview } from "./preflight";

const SEQUENCES = "@canon/sequences";
const MAX_STEPS = 100;
const MAX_VARIANTS = 20;
const LIVE = ["pending", "active", "paused"] as const;
type Step = Doc<"sequenceLaunches">["approvedPlan"]["steps"][number];
type Trusted = { ctx: MutationCtx; pkg: Doc<"modulePackages">; scope: ModuleScope; user: Doc<"users">; admitted: ReadonlySet<string> };
const contexts = new WeakMap<Sq1TrustedContext, Trusted>();
declare const trusted: unique symbol;
export type Sq1TrustedContext = { readonly [trusted]: true };

const refuse = (message: string): never => { throw new ConvexError(message); };
const object = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === "object" && !Array.isArray(x);
const integer = (x: unknown, min: number, max: number): x is number => typeof x === "number" && Number.isSafeInteger(x) && x >= min && x <= max;
const hash = async (value: unknown) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson(value))))].map((x) => x.toString(16).padStart(2, "0")).join("");
const pick = (data: Record<string, unknown>, fields: readonly string[]) => Object.fromEntries(fields.map((f) => [f, data[f] ?? null]));
const changedProjection = (p: Sq1Projection, fields: Record<string, unknown>): Sq1Projection => ({ ...p, fields: { ...p.fields, ...fields }, absent: p.absent.filter((f) => !Object.hasOwn(fields, f)) });

export async function sq1HumanContext(ctx: MutationCtx, admitted: readonly string[] = []): Promise<Sq1TrustedContext> {
  const user = await getCurrentUser(ctx);
  const scope = await moduleScope(ctx, SEQUENCES);
  const pkg = user ? await installedModule(ctx, user.orgId, SEQUENCES) : null;
  if (!user || user.isHidden || !pkg || !scope || scope.agent || scope.preview || scope.userId !== user._id || pkg.pending || !(await roleIn(ctx, user, user.orgId))) return refuse("Run this sequence lifecycle as a signed-in person on its installed module.");
  const authority = Object.freeze({}) as Sq1TrustedContext;
  contexts.set(authority, { ctx, pkg, scope, user, admitted: new Set(admitted) });
  return authority;
}

async function context(ctx: MutationCtx, authority: Sq1TrustedContext): Promise<Trusted> {
  const bound = contexts.get(authority);
  if (!bound || bound.ctx !== ctx) return refuse("Sequence authority belongs to its original transaction.");
  const pkg = await installedModule(ctx, bound.pkg.orgId, bound.pkg.moduleId);
  const user = await ctx.db.get(bound.user._id);
  if (!user || user.isHidden || !pkg || pkg.pending || (pkg.epoch ?? 1) !== (bound.pkg.epoch ?? 1) || !(await isEnabled(ctx, pkg.orgId, pkg.moduleId)) || !(await roleIn(ctx, user, pkg.orgId))) return refuse("The live sequence lifecycle context changed.");
  return bound;
}

async function projection(bound: Trusted, collection: string, key: string, fields?: readonly string[]): Promise<Sq1Projection> {
  if (!(await bound.scope.peek(collection, key))) return refuse("The sequence source is not visible to you.");
  const row = await sq1ProjectionDoc(bound.ctx, bound.pkg.orgId, bound.pkg.moduleId, collection, key);
  if (!row) return refuse("The sequence source no longer exists.");
  const boundFields = fields ?? Object.keys(manifestOf(bound.pkg).collections[collection].schema.value);
  return { collection, key, fields: pick(row.data, boundFields), absent: boundFields.filter((f) => !Object.hasOwn(row.data, f)), ...(row.ownerUserId === undefined ? {} : { ownerUserId: row.ownerUserId }), ...(row.parentKey === undefined ? {} : { parentKey: row.parentKey }), ...(row.gen === undefined ? {} : { gen: row.gen }), ...(row.gens === undefined ? {} : { gens: row.gens }) };
}

async function loadPlan(bound: Trusted, key: string) {
  const seq = await bound.scope.peek("sequences", key);
  if (!seq || !(bound.scope.role === "admin" || bound.scope.role === "manager" || seq.data.owner === bound.user._id)) return refuse("Only the sequence owner, a manager or an admin approves a launch.");
  const raw = await bound.scope.view("steps.forSequence", { sequence: key });
  if (!Array.isArray(raw) || !raw.length || raw.length > MAX_STEPS) return refuse("A canonical launch needs between one and 100 steps.");
  const rows = [...raw].sort((a, b) => Number(a.data.position) - Number(b.data.position));
  const positions = new Set<number>();
  const steps: Step[] = [];
  const sources: Sq1Projection[] = [];
  for (const [ordinal, row] of rows.entries()) {
    const data = row.data;
    if (!integer(data.position, 0, Number.MAX_SAFE_INTEGER) || positions.has(data.position) || !integer(data.delayDays, 0, 3650)) return refuse("Step positions and delays must be valid and unambiguous.");
    positions.add(data.position);
    const kind = data.kind;
    if (kind !== "auto_email" && kind !== "manual_email" && kind !== "call" && kind !== "task" && kind !== "linkedin_task") return refuse("Automatic LinkedIn needs separate account-owner action consent.");
    const variants: Step["variants"] = [];
    const ids = new Set<string>();
    const candidates = data.variants ?? [];
    if (!Array.isArray(candidates) || candidates.length > MAX_VARIANTS) return refuse("A step has too many template variants.");
    for (const v of candidates) {
      if (!object(v) || v.paused === true) continue;
      if (typeof v.id !== "string" || !v.id || ids.has(v.id) || typeof v.subject !== "string" || !v.subject.trim() || v.subject.length > 200 || /[\r\n]/.test(v.subject)
        || typeof v.body !== "string" || !v.body.trim() || v.body.length > 5000 || !integer(v.weight, 1, 100)) return refuse("The approved email variants must be complete and uniquely named.");
      ids.add(v.id);
      variants.push({ key: v.id, weight: v.weight, subject: v.subject, body: v.body, templateHash: await hash(["canon.sq1.template.v1", "email", v.subject, v.body]) });
    }
    if (kind === "auto_email" && (!variants.length || variants.reduce((n, v) => n + v.weight, 0) !== 100)) return refuse("An automatic email needs active variants totaling 100 percent.");
    steps.push({ key: row.key, ordinal, occurrence: 0, kind, delayDays: data.delayDays, thread: data.thread === true, variants: kind === "auto_email" ? variants : [] });
    sources.push(await projection(bound, "steps", row.key));
  }
  if (!steps.some((s) => s.kind === "auto_email")) return refuse("Manual-only sequences keep their existing lifecycle.");
  const scheduleKey = seq.data.schedule;
  const scheduleDoc = typeof scheduleKey === "string" ? await bound.scope.peek("schedules", scheduleKey) : null;
  if (typeof scheduleKey === "string" && !scheduleDoc) return refuse("The approved schedule is not visible.");
  const s = scheduleDoc?.data;
  const schedule = s ? { days: Array.isArray(s.days) ? s.days.map(Number) : [], start: String(s.start), end: String(s.end), timeZone: String(s.timeZone), holidays: Array.isArray(s.holidays) ? s.holidays.map(String) : [] }
    : { days: [1, 2, 3, 4, 5], start: "08:00", end: "17:00", timeZone: "America/New_York", holidays: [] };
  if (!schedule.days.length || schedule.days.some((d) => !integer(d, 0, 6)) || !/^\d{2}:\d{2}$/.test(schedule.start) || !/^\d{2}:\d{2}$/.test(schedule.end) || schedule.start >= schedule.end) return refuse("The approved send schedule is invalid.");
  try { new Intl.DateTimeFormat("en", { timeZone: schedule.timeZone }).format(); } catch { return refuse("The approved schedule timezone is invalid."); }
  if (scheduleDoc) sources.push(await projection(bound, "schedules", scheduleKey as string, Object.keys(manifestOf(bound.pkg).collections.schedules.schema.value).filter((f) => f !== "name")));
  const reader = senderReader(bound.ctx, bound.pkg.orgId, await accessFor(bound.ctx, bound.user));
  const senders: Id<"emailAccounts">[] = [];
  if (!Array.isArray(seq.data.senders)) return refuse("Select actual linked mailbox references before approving a launch.");
  for (const rawSender of seq.data.senders) {
    if (!object(rawSender) || rawSender.channel !== "email" || typeof rawSender.sender !== "string") return refuse("Only linked email senders are supported by this launch authority.");
    const id = bound.ctx.db.normalizeId("emailAccounts", rawSender.sender);
    const sender = id ? await reader.byId(id) : null;
    if (!id || !sender || sender.status !== "ok") return refuse("A selected mailbox is unavailable to you.");
    if (!senders.includes(id)) senders.push(id);
  }
  if (!senders.length || senders.length > 20) return refuse("Select between one and 20 linked mailboxes.");
  const seqProjection = await projection(bound, "sequences", key, Object.keys(manifestOf(bound.pkg).collections.sequences.schema.value).filter((f) => f !== "name"));
  const settings = { ...seqProjection.fields };
  delete settings.status;
  const plan = { steps, settings, schedule };
  const templates = steps.flatMap((step) => step.variants.map((variant) => ({ step: { key: step.key, ordinal: step.ordinal }, variant: variant.key, channel: "email" as const, templateHash: variant.templateHash })))
    .sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b), "en"));
  return { seqProjection, sources, plan, senders, templates, planDigest: await hash(["canon.sq1.plan.v1", plan]), templateSetHash: await hash(["canon.sq1.template-set.v1", templates]) };
}

export type Sq1LifecycleCommand =
  | { kind: "approveLaunch"; sequenceKey: string; expectedProjectionVersion: number; expectedLaunchRevision?: number; totalRequestCap: number; variableReview?: string }
  | { [K in "pauseLaunch" | "archiveLaunch" | "finishLaunch" | "invalidateTemplateSet"]: { kind: K; launchId: Id<"sequenceLaunches">; expectedLaunchRevision: number } }["pauseLaunch" | "archiveLaunch" | "finishLaunch" | "invalidateTemplateSet"]
  | { kind: "bindEnrollment"; launchId: Id<"sequenceLaunches">; enrollmentKey: string; expectedLaunchRevision: number; expectedProjectionVersion: number }
  | { kind: "editPlanSource"; launchId: Id<"sequenceLaunches">; expectedLaunchRevision: number; collection: string; key: string; expectedProjectionVersion: number; patch: Record<string, unknown> }
  | { kind: "skipCurrentStep"; enrollmentId: Id<"sequenceEnrollments">; expectedEnrollmentRevision: number; expectedStepKey: string }
  | { [K in "pauseEnrollment" | "resumeEnrollment" | "finishEnrollment"]: { kind: K; enrollmentId: Id<"sequenceEnrollments">; expectedEnrollmentRevision: number } }["pauseEnrollment" | "resumeEnrollment" | "finishEnrollment"]
  | { kind: "withdrawRequest"; requestId: Id<"outboxRequests">; expectedRequestRevision: number };

async function launchFor(bound: Trusted, id: Id<"sequenceLaunches">, revision?: number) {
  const launch = await bound.ctx.db.get(id);
  if (!launch || launch.orgId !== bound.pkg.orgId || launch.moduleId !== bound.pkg.moduleId || launch.packageEpoch !== (bound.pkg.epoch ?? 1)
    || revision !== undefined && launch.revision !== revision || !(await bound.scope.peek(launch.projection.collection, launch.projection.key))) return refuse("The canonical launch changed or is unavailable.");
  if (!(bound.scope.role === "admin" || bound.scope.role === "manager" || launch.projection.fields.owner === bound.user._id)) return refuse("You cannot change this canonical launch.");
  return launch;
}

async function withdrawUnreserved(ctx: MutationCtx, requestId: Id<"outboxRequests"> | undefined) {
  if (!requestId) return;
  const request = await ctx.db.get(requestId);
  if (request && (request.state === "preparing" || request.state === "ready")) {
    const { _id, _creationTime, ...data } = request;
    void _creationTime;
    await ctx.db.replace(_id, { ...data, state: "withdrawn", revision: request.revision + 1 });
  }
}

export async function applySq1Lifecycle(ctx: MutationCtx, authority: Sq1TrustedContext, command: Sq1LifecycleCommand): Promise<{ id: Id<"sequenceLaunches"> | Id<"sequenceEnrollments"> | Id<"outboxRequests">; revision: number }> {
  const bound = await context(ctx, authority), { pkg, user } = bound;
  const actor = { kind: "user" as const, userId: user._id };
  if (command.kind === "approveLaunch") {
    if (!integer(command.totalRequestCap, 1, 10_000)) return refuse("A launch needs an explicit logical request limit.");
    const source = await bound.scope.peek("sequences", command.sequenceKey);
    if (!source || source.version !== command.expectedProjectionVersion || source.data.status !== "draft" && source.data.status !== "paused") return refuse("The sequence changed or is not awaiting launch consent.");
    const previous = await ctx.db.query("sequenceLaunches").withIndex("by_orgId_and_moduleId_and_moduleSequenceKey", (q) => q.eq("orgId", pkg.orgId).eq("moduleId", pkg.moduleId).eq("moduleSequenceKey", command.sequenceKey)).unique();
    if (previous ? previous.revision !== command.expectedLaunchRevision || previous.state !== "paused" || command.totalRequestCap < previous.reservedRequests : command.expectedLaunchRevision !== undefined) return refuse("The canonical launch changed; review it before consenting.");
    if (!previous && (await sq1Launches(ctx, pkg.orgId, pkg.moduleId)).length >= SQ1_MAX_LAUNCHES) return refuse("This module has reached its canonical launch limit.");
    await requireVariableReview(await bound.scope.sequenceVariables(command.sequenceKey), command.variableReview);
    const approved = await loadPlan(bound, command.sequenceKey);
    if (previous && (await ctx.db.query("sequenceEnrollments").withIndex("by_launchId_and_state", (q) => q.eq("launchId", previous._id)).take(1)).length) {
      const structure = (p: Doc<"sequenceLaunches">["approvedPlan"]) => ({ ...p, steps: p.steps.map(({ variants, ...step }) => { void variants; return step; }) });
      if (canonicalJson(structure(previous.approvedPlan)) !== canonicalJson(structure(approved.plan))) return refuse("A bound execution plan cannot be reordered or rebound. Its template variants may be reapproved under fresh consent.");
    }
    const revision = (previous?.revision ?? 0) + 1;
    const data = { orgId: pkg.orgId, moduleId: pkg.moduleId, moduleSequenceKey: command.sequenceKey, revision, authorizationEpoch: (previous?.authorizationEpoch ?? 0) + 1, state: "active" as const,
      approvedBy: user._id, approvedAt: Date.now(), packageEpoch: pkg.epoch ?? 1, projection: changedProjection(approved.seqProjection, { status: "active" }), sources: approved.sources,
      approvedPlan: approved.plan, planDigest: approved.planDigest, templateSetVersion: 1 as const, approvedTemplates: approved.templates, templateSetHash: approved.templateSetHash,
      approvedSenderRefs: approved.senders, allowedChannels: ["email" as const], totalRequestCap: command.totalRequestCap, reservedRequests: previous?.reservedRequests ?? 0 };
    const id = previous ? (await ctx.db.replace(previous._id, data), previous._id) : await ctx.db.insert("sequenceLaunches", data);
    await projectSq1Lifecycle(ctx, pkg, "sequences", command.sequenceKey, actor);
    return { id, revision };
  }
  if (command.kind === "pauseLaunch" || command.kind === "archiveLaunch" || command.kind === "finishLaunch" || command.kind === "invalidateTemplateSet") {
    const launch = await launchFor(bound, command.launchId, command.expectedLaunchRevision);
    if (launch.state === "finished" || launch.state === "archived") return refuse("This launch is terminal.");
    const state = command.kind === "archiveLaunch" ? "archived" : command.kind === "finishLaunch" ? "finished" : "paused";
    const revision = launch.revision + 1;
    await ctx.db.patch(launch._id, { state, revision, authorizationEpoch: launch.authorizationEpoch + 1, projection: changedProjection(launch.projection, { status: state === "finished" ? "paused" : state }) });
    await projectSq1Lifecycle(ctx, pkg, launch.projection.collection, launch.projection.key, actor);
    return { id: launch._id, revision };
  }
  if (command.kind === "bindEnrollment") {
    const launch = await launchFor(bound, command.launchId, command.expectedLaunchRevision);
    if (launch.state !== "active") return refuse("The launch is not active.");
    const row = await bound.scope.peek("enrollments", command.enrollmentKey);
    if (!row || row.version !== command.expectedProjectionVersion || row.data.sequence !== launch.moduleSequenceKey || typeof row.data.contact !== "string" || !row.data.contact.startsWith("con_")
      || !bound.admitted.has(`people::${row.data.contact}`) || typeof row.data.rep !== "string" || !integer(row.data.stepIndex, 0, launch.approvedPlan.steps.length - 1)) return refuse("The enrollment changed or its actual contact has not been admitted as this caller.");
    const rep = ctx.db.normalizeId("users", row.data.rep), member = rep ? await ctx.db.get(rep) : null;
    if (!member || !rep || !(await roleIn(ctx, member, pkg.orgId))) return refuse("The assigned rep is not an active workspace member.");
    const identityKey = canonicalJson([pkg.moduleId, launch.moduleSequenceKey, row.data.contact]);
    if (await ctx.db.query("sequenceEnrollments").withIndex("by_orgId_and_identityKey", (q) => q.eq("orgId", pkg.orgId).eq("identityKey", identityKey)).unique()) return refuse("This enrollment identity already has canonical history.");
    for (const state of LIVE) if ((await ctx.db.query("sequenceEnrollments").withIndex("by_orgId_and_contactId_and_state", (q) => q.eq("orgId", pkg.orgId).eq("contactId", row.data.contact as string).eq("state", state)).take(1)).length) return refuse("This person already has active canonical outreach.");
    const state = row.data.state;
    if (state !== "pending" && state !== "active" && state !== "paused") return refuse("Only a current enrollment can be explicitly bound.");
    const step = launch.approvedPlan.steps[row.data.stepIndex];
    let p = await projection(bound, "enrollments", command.enrollmentKey, Object.keys(manifestOf(bound.pkg).collections.enrollments.schema.value).filter((f) => f !== "contactName" && f !== "title"));
    const planned = plan({ stepIndex: step.ordinal, lastDay: typeof row.data.lastDay === "string" ? row.data.lastDay : null }, launch.approvedPlan.steps.map((s) => ({ kind: s.kind, delayDays: s.delayDays })), launch.approvedPlan.schedule, Date.now(), launch.approvedPlan.settings.intervalType === "calendar_days" ? "calendar_days" : "schedule_days");
    if (planned.done) return refuse("This enrollment has no remaining approved step.");
    p = changedProjection(p, { nextAt: planned.nextAt });
    const id = await ctx.db.insert("sequenceEnrollments", { orgId: pkg.orgId, moduleId: pkg.moduleId, launchId: launch._id, moduleEnrollmentKey: command.enrollmentKey, identityKey, contactId: row.data.contact, assignedRep: rep,
      revision: 1, state, currentStep: { stepKey: step.key, ordinal: step.ordinal, occurrence: 0 }, projection: p });
    await projectSq1Lifecycle(ctx, pkg, p.collection, p.key, actor);
    return { id, revision: 1 };
  }
  if (command.kind === "editPlanSource") {
    const launch = await launchFor(bound, command.launchId, command.expectedLaunchRevision);
    if (launch.state !== "active" && launch.state !== "paused") return refuse("A terminal launch cannot be edited.");
    const source = launch.sources.find((p) => p.collection === command.collection && p.key === command.key);
    const row = source ? await bound.scope.peek(source.collection, source.key) : null;
    if (!source || !row || row.version !== command.expectedProjectionVersion || !Object.keys(command.patch).length
      || Object.keys(command.patch).some((f) => !Object.hasOwn(source.fields, f))) return refuse("The bound plan source changed or the edit changes its identity.");
    const revision = launch.revision + 1;
    const changed = changedProjection(source, command.patch);
    await ctx.db.patch(launch._id, { state: "paused", revision, authorizationEpoch: launch.authorizationEpoch + 1,
      sources: launch.sources.map((p) => p.collection === source.collection && p.key === source.key ? changed : p),
      projection: changedProjection(launch.projection, { status: "paused" }) });
    await projectSq1Lifecycle(ctx, pkg, source.collection, source.key, actor);
    await projectSq1Lifecycle(ctx, pkg, launch.projection.collection, launch.projection.key, actor);
    return { id: launch._id, revision };
  }
  if (command.kind === "withdrawRequest") {
    const request = await ctx.db.get(command.requestId);
    if (!request || request.orgId !== pkg.orgId || request.moduleId !== pkg.moduleId || request.revision !== command.expectedRequestRevision || request.state !== "preparing" && request.state !== "ready") return refuse("This request changed or has already been reserved.");
    await launchFor(bound, request.launchId);
    await withdrawUnreserved(ctx, request._id);
    return { id: request._id, revision: request.revision + 1 };
  }
  const enrollment = await ctx.db.get(command.enrollmentId);
  if (!enrollment || enrollment.orgId !== pkg.orgId || enrollment.moduleId !== pkg.moduleId || enrollment.revision !== command.expectedEnrollmentRevision || enrollment.state === "finished") return refuse("The canonical enrollment changed or is finished.");
  const launch = await launchFor(bound, enrollment.launchId);
  if (command.kind === "skipCurrentStep") {
    if (launch.state !== "active" || enrollment.state !== "active" || enrollment.currentStep.stepKey !== command.expectedStepKey) return refuse("The active step changed before this human skip.");
    const request = enrollment.currentRequestId ? await ctx.db.get(enrollment.currentRequestId) : null;
    if (request && request.state !== "preparing" && request.state !== "ready" && request.state !== "withdrawn" && request.state !== "invalidated") return refuse("Dispatched or unknown work must settle or reconcile before this step advances.");
    const now = Date.now(), nextOrdinal = enrollment.currentStep.ordinal + 1;
    const pacing = launch.approvedPlan.settings.intervalType;
    const planned = plan({ stepIndex: nextOrdinal, lastDay: localDate(now, launch.approvedPlan.schedule.timeZone) }, launch.approvedPlan.steps.map((s) => ({ kind: s.kind, delayDays: s.delayDays })), launch.approvedPlan.schedule, now, pacing === "calendar_days" ? "calendar_days" : "schedule_days");
    await withdrawUnreserved(ctx, enrollment.currentRequestId);
    const state = planned.done ? "finished" : "active";
    const fields = { stepIndex: nextOrdinal, state, ...(planned.done ? { finishReason: "completed" } : { nextAt: planned.nextAt, lastDay: localDate(now, launch.approvedPlan.schedule.timeZone) }) };
    const nextStep = launch.approvedPlan.steps[nextOrdinal];
    const revision = enrollment.revision + 1;
    await ctx.db.patch(enrollment._id, { revision, state, currentRequestId: undefined, projection: changedProjection(enrollment.projection, fields),
      ...(nextStep ? { currentStep: { stepKey: nextStep.key, ordinal: nextOrdinal, occurrence: 0 as const } } : { finishReason: "completed", finishedAt: now }) });
    await projectSq1Lifecycle(ctx, pkg, enrollment.projection.collection, enrollment.projection.key, actor);
    const tasks = await bound.scope.view("tasks.openForEnrollment", { sequence: launch.moduleSequenceKey, contact: enrollment.contactId });
    if (!Array.isArray(tasks)) throw new ConvexError("The matching enrollment task view is unavailable.");
    for (const task of tasks) if (task.data.stepIndex === enrollment.currentStep.ordinal) await bound.scope.transition("task", "skip", { key: task.key, expect: task.version });
    return { id: enrollment._id, revision };
  }
  if (command.kind === "resumeEnrollment" && (launch.state !== "active" || enrollment.state !== "paused")) return refuse("Fresh live launch consent is needed before resuming.");
  const state = command.kind === "finishEnrollment" ? "finished" : command.kind === "resumeEnrollment" ? "active" : "paused";
  const revision = enrollment.revision + 1;
  await withdrawUnreserved(ctx, enrollment.currentRequestId);
  const fields = { state, ...(state === "finished" ? { finishReason: "manual" } : {}) };
  await ctx.db.patch(enrollment._id, { state, revision, currentRequestId: undefined, projection: changedProjection(enrollment.projection, fields), ...(state === "finished" ? { finishReason: "manual", finishedAt: Date.now() } : {}) });
  await projectSq1Lifecycle(ctx, pkg, enrollment.projection.collection, enrollment.projection.key, actor);
  if (state === "finished") {
    const tasks = await bound.scope.view("tasks.openForEnrollment", { sequence: launch.moduleSequenceKey, contact: enrollment.contactId });
    if (!Array.isArray(tasks)) throw new ConvexError("The matching enrollment task view is unavailable.");
    for (const task of tasks) await bound.scope.transition("task", "skip", { key: task.key, expect: task.version });
  }
  return { id: enrollment._id, revision };
}

export async function pauseSq1Package(ctx: MutationCtx, orgId: Id<"organizations">, moduleId: string, userId: Id<"users">): Promise<void> {
  const launches = await sq1Launches(ctx, orgId, moduleId);
  if (!launches.length) return;
  const pkg = await installedModule(ctx, orgId, moduleId);
  if (!pkg) throw new ConvexError("A canonical lifecycle cannot be detached from its package.");
  for (const launch of launches) {
    if (launch.state === "finished" || launch.state === "archived") continue;
    await ctx.db.patch(launch._id, { state: "paused", revision: launch.revision + 1, authorizationEpoch: launch.authorizationEpoch + 1,
      projection: changedProjection(launch.projection, { status: "paused" }) });
    await projectSq1Lifecycle(ctx, pkg, launch.projection.collection, launch.projection.key, { kind: "user", userId });
  }
}

export async function prepareSq1EmailRequest(ctx: MutationCtx, authority: Sq1TrustedContext, enrollmentId: Id<"sequenceEnrollments">, expectedRevision: number): Promise<Id<"outboxRequests">> {
  const bound = await context(ctx, authority);
  const enrollment = await ctx.db.get(enrollmentId);
  if (!enrollment || enrollment.orgId !== bound.pkg.orgId || enrollment.moduleId !== bound.pkg.moduleId || enrollment.revision !== expectedRevision || enrollment.state !== "active") return refuse("The current enrollment changed or is inactive.");
  const launch = await launchFor(bound, enrollment.launchId);
  const step = launch.approvedPlan.steps[enrollment.currentStep.ordinal];
  if (launch.state !== "active" || !step || step.key !== enrollment.currentStep.stepKey || step.kind !== "auto_email" || launch.reservedRequests >= launch.totalRequestCap) return refuse("No authorized automatic email is current for this enrollment.");
  const history = await ctx.db.query("outboxRequests").withIndex("by_enrollmentId_and_stepKey_and_occurrence", (q) => q.eq("enrollmentId", enrollment._id).eq("stepKey", step.key).eq("occurrence", 0)).take(21);
  if (history.length > 20 || history.some((r) => r.state === "reserved" || r.state === "sent" || r.state === "unknown" || r.state === "failed")) return refuse("This step has dispatched history or requires reconciliation.");
  const open = history.filter((r) => r.state === "preparing" || r.state === "ready");
  if (open.length > 1) throw new ConvexError("The current step has conflicting canonical requests.");
  if (open.length) {
    if (open[0].authorizationEpoch !== launch.authorizationEpoch || enrollment.currentRequestId !== open[0]._id) return refuse("The current request has stale launch consent.");
    return open[0]._id;
  }
  const nextAt = enrollment.projection.fields.nextAt;
  if (!integer(nextAt, 0, Number.MAX_SAFE_INTEGER)) return refuse("The current step has no canonical scheduled earliest-send time.");
  const id = await ctx.db.insert("outboxRequests", { orgId: enrollment.orgId, moduleId: enrollment.moduleId, launchId: launch._id, enrollmentId: enrollment._id,
    stepKey: step.key, ordinal: step.ordinal, occurrence: 0, authorizationEpoch: launch.authorizationEpoch, revision: 1, state: "preparing", requestedNotBefore: nextAt });
  await ctx.db.patch(enrollment._id, { revision: enrollment.revision + 1, currentRequestId: id });
  await projectSq1Lifecycle(ctx, bound.pkg, enrollment.projection.collection, enrollment.projection.key, { kind: "user", userId: bound.user._id });
  return id;
}
