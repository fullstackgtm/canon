import type { CallContext, CallFunctions, DealChange, Intent, ReadDoc } from "../../kernel/calls.ts";
import { addDays, assessRoom, slipBanner, dateOf, planFromTemplate, resolveOwner, stepFigures, type SellerMember, type Side, type Stakeholder, type StepFigures, type TemplateStep } from "./dealRooms.calc.ts";

type Deal = { id: string; name?: string; amount?: number; closeDate?: string | null; ownerId?: string | null; companyName?: string | null; stage?: string; isClosed?: boolean; isWon?: boolean };
const today = (ctx: CallContext) => dateOf(ctx.now);
const fail = (message: string): never => { throw new Error(message); };

export const SEED_TEMPLATES: Array<{ key: string; name: string; kind: "close" | "onboarding"; description: string; steps: Omit<TemplateStep, "order">[] }> = [
  {
    key: "enterprise-close", name: "Enterprise close plan", kind: "close",
    description: "Ten steps from the discovery recap to the kickoff, counted back from the close date.",
    steps: [
      { title: "Discovery recap confirmed", milestoneTitle: "Discovery", side: "buyer", daysBeforeClose: 45, ownerRole: "champion" },
      { title: "Success criteria signed off", milestoneTitle: "Discovery", side: "buyer", daysBeforeClose: 40, ownerRole: "champion" },
      { title: "Technical validation", milestoneTitle: "Validation", side: "seller", daysBeforeClose: 35, ownerRole: "Account executive" },
      { title: "Security questionnaire returned", milestoneTitle: "Validation", side: "buyer", daysBeforeClose: 30, ownerRole: "champion" },
      { title: "Business case to CFO", milestoneTitle: "Business case", side: "seller", daysBeforeClose: 25, ownerRole: "Account executive" },
      { title: "Executive sponsor meeting", milestoneTitle: "Business case", side: "both", daysBeforeClose: 20, ownerRole: "executive" },
      { title: "Legal redlines", milestoneTitle: "Paper process", side: "buyer", daysBeforeClose: 14, ownerRole: "champion" },
      { title: "Procurement vendor setup", milestoneTitle: "Paper process", side: "buyer", daysBeforeClose: 10, ownerRole: "procurement" },
      { title: "Order form signed", milestoneTitle: "Paper process", side: "buyer", daysBeforeClose: 3, ownerRole: "executive" },
      { title: "Kickoff scheduled", milestoneTitle: "Kickoff", side: "seller", daysBeforeClose: -7, ownerRole: "Account executive" },
    ],
  },
  {
    key: "onboarding", name: "Onboarding plan", kind: "onboarding",
    description: "From the kickoff to the first value review, counted on from the close date.",
    steps: [
      { title: "Kickoff meeting held", milestoneTitle: "Kickoff", side: "both", daysBeforeClose: -7, ownerRole: "executive" },
      { title: "Admins named and invited", milestoneTitle: "Setup", side: "buyer", daysBeforeClose: -10, ownerRole: "champion" },
      { title: "Data imported", milestoneTitle: "Setup", side: "seller", daysBeforeClose: -14, ownerRole: "Account executive" },
      { title: "Integrations connected", milestoneTitle: "Setup", side: "both", daysBeforeClose: -21, ownerRole: "champion" },
      { title: "Team trained", milestoneTitle: "Adoption", side: "seller", daysBeforeClose: -28, ownerRole: "Account executive" },
      { title: "First value review", milestoneTitle: "Adoption", side: "both", daysBeforeClose: -45, ownerRole: "executive" },
    ],
  },
];

const stakeholdersOf = (room: ReadDoc) => (room.data.stakeholders ?? []) as Stakeholder[];
const teamOf = (room: ReadDoc) => (room.data.sellerTeam ?? []) as SellerMember[];
const figuresOf = (steps: ReadDoc[]) => steps.map((s) => s.data as unknown as StepFigures);
const kindOf = (room: ReadDoc) => (room.data.kind === "onboarding" ? "onboarding" : "close");
const HEALTH: Record<string, string> = { on_track: "On track", needs_attention: "Needs attention", at_risk: "At risk" };
const STATUS: Record<string, string> = { draft: "Draft", live: "Live", won: "Won", lost: "Lost", archived: "Archived" };
const KIND: Record<string, string> = { close: "Close plan", onboarding: "Onboarding plan" };
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function reorder(collection: string, docs: ReadDoc[], keys: string[]): Intent[] {
  const byKey = new Map(docs.map((d) => [d.key, d]));
  return keys.flatMap((key, i) => {
    const d = byKey.get(key);
    return d && d.data.order !== i + 1 ? [{ op: "patch", collection, key, data: { order: i + 1 }, expect: [{ collection, key, version: d.version }] } as Intent] : [];
  });
}

const isOpen = (room: ReadDoc) => room.data.status === "draft" || room.data.status === "live";
const dirtyRooms = (rooms: ReadDoc[]): Intent[] => rooms.filter(isOpen).map((r) => ({ op: "dirty", job: "health", key: r.key }));

export const calls: CallFunctions = {
  onDeals(ctx) {
    const ids = [...new Set(((ctx.args.changes ?? []) as DealChange[]).map((c) => c.id))];
    return { intents: ids.flatMap((id) => ["close", "onboarding"].map((kind): Intent => ({ op: "dirty", job: "health", key: `${id}|${kind}` }))) };
  },

  health(ctx, reads) {
    const rooms = new Map((reads.rooms as ReadDoc[]).map((r) => [r.key, r]));
    const deals = new Map((reads.deals as Deal[]).map((d) => [d.id, d]));
    const byKey: Record<string, Intent[]> = {};
    for (const key of ctx.args.keys as string[]) {
      const room = rooms.get(key);
      const deal = room && deals.get(room.data.deal as string);
      if (!room || !isOpen(room) || !deal) { byKey[key] = []; continue; }
      const steps = (reads.steps as ReadDoc[]).filter((s) => s.parentKey === key);
      const expect = [{ collection: "rooms", key, version: room.version }, ...steps.map((s) => ({ collection: "steps", key: s.key, version: s.version }))];
      const f = assessRoom({ steps: figuresOf(steps), now: ctx.now, closeDate: deal.closeDate, kind: kindOf(room), status: room.data.status as string, lastBuyerAt: room.data.lastBuyerAt as number | undefined });
      const values: Record<string, unknown> = { health: f.health, progress: f.progress, slipDays: f.slipDays, overdue: f.overdue, buyerOverdueMax: f.buyerOverdueMax, planEnd: f.planEnd, nextDue: f.nextDue ?? null, quietDays: f.quietDays, targetDate: deal.closeDate ?? null, ...(deal.ownerId ? { rep: deal.ownerId } : {}) };
      const data = Object.fromEntries(Object.entries(values).filter(([k, v]) => v !== null && room.data[k] !== v));
      const unset = Object.keys(values).filter((k) => values[k] === null && room.data[k] !== undefined);
      const intents: Intent[] = Object.keys(data).length || unset.length ? [{ op: "patch", collection: "rooms", key, data, unset, expect }] : [];
      if (deal.isClosed) intents.push({ op: "transition", machine: "room", name: deal.isWon ? "closeWon" : "closeLost", key, expect });
      byKey[key] = intents;
    }
    return { byKey };
  },

  hourly(_ctx, reads) { return { intents: dirtyRooms(reads.rooms as ReadDoc[]) }; },

  daily(ctx, reads) {
    const rooms = (reads.rooms as ReadDoc[]).filter(isOpen);
    const tomorrow = addDays(today(ctx), 1);
    const intents = dirtyRooms(rooms);
    for (const room of rooms) {
      const counts = new Map<string, number>();
      for (const step of reads.steps as ReadDoc[]) {
        const d = step.data;
        if (step.parentKey !== room.key || d.status !== "open" || d.dueOn !== tomorrow || d.side === "buyer" || typeof d.sellerOwner !== "string") continue;
        counts.set(d.sellerOwner, (counts.get(d.sellerOwner) ?? 0) + 1);
      }
      for (const [owner, count] of counts) intents.push({ op: "notify", to: [owner], subject: "Deal room steps due tomorrow", message: `${String(room.data.title).slice(0, 200)}: ${plural(count, "step")} due tomorrow.`, link: `rooms/${encodeURIComponent(room.key)}?view=plan`, badge: "Deal room" });
    }
    return { intents };
  },

  digest(ctx, reads) {
    const rooms = reads.rooms as ReadDoc[];
    const open = rooms.filter(isOpen);
    const keys = new Set(open.map((r) => r.key));
    const steps = (reads.steps as ReadDoc[]).filter((s) => keys.has(s.parentKey!));
    return { value: { live: rooms.filter((r) => r.data.status === "live").length, atRisk: open.filter((r) => r.data.health === "at_risk").length, overdue: stepFigures(figuresOf(steps), today(ctx)).overdue, buyerActions: null, buyerActivity: "Buyer activity is not available yet." } };
  },
  seedTemplates(_ctx, reads) {
    const have = new Set((reads.templates as ReadDoc[]).map((t) => t.key));
    const intents: Intent[] = [];
    for (const t of SEED_TEMPLATES.filter((x) => !have.has(x.key))) {
      intents.push({ op: "put", collection: "templates", key: t.key, data: { name: t.name, kind: t.kind, description: t.description, active: true }, expect: [{ collection: "templates", key: t.key, version: null }] });
      t.steps.forEach((s, i) => intents.push({ op: "put", collection: "templateSteps", parentKey: t.key, data: { ...s, order: i + 1 } }));
    }
    return { intents, value: { added: intents.filter((i) => i.op === "put" && i.collection === "templates").length } };
  },

  fromTemplate(ctx, reads) {
    const template = reads.template as ReadDoc | null;
    const deal = (reads.deal as Deal[])[0];
    if (!template) fail("That template doesn't exist, or it isn't yours to see.");
    if (!deal) fail("That deal doesn't exist, or it isn't yours to see.");
    if (template!.data.active === false) fail(`${template!.data.name} is turned off.`);
    const kind = template!.data.kind as "close" | "onboarding";
    if ((reads.existing as ReadDoc[]).some((r) => r.data.kind === kind)) fail(`${deal!.name ?? "This deal"} already has a ${kind === "close" ? "close" : "onboarding"} room.`);
    if (!deal!.closeDate) fail(`Set ${deal!.name ?? "the deal"}'s close date first: the plan's dates count back from it.`);
    const tsteps = (reads.steps as ReadDoc[]).map((d) => d.data as unknown as TemplateStep);
    if (!tsteps.length) fail(`${template!.data.name} has no steps yet.`);

    const rep = deal!.ownerId ?? ctx.caller.userId;
    const team: SellerMember[] = [{ member: rep, role: "Account executive" }];
    const people = ((ctx.args.stakeholders ?? []) as Stakeholder[]).filter((p) => p.name?.trim());
    const key = `${deal!.id}|${kind}`;
    const plan = planFromTemplate(key, deal!.closeDate!, tsteps, team, people);
    const assessment = assessRoom({ steps: plan.steps.map((s) => ({ ...s, status: "open" })), now: ctx.now, closeDate: deal!.closeDate, kind, status: "draft" });
    const title = (ctx.args.title as string | undefined)?.trim() || `${deal!.name ?? "Deal"}: ${kind === "close" ? "mutual action plan" : "onboarding plan"}`;
    const intents: Intent[] = [
      { op: "put", collection: "rooms", key, data: { deal: deal!.id, kind, rep, title, template: template!.data.name, sellerTeam: team, stakeholders: people, targetDate: deal!.closeDate, health: assessment.health, progress: assessment.progress, slipDays: assessment.slipDays, overdue: assessment.overdue }, expect: [{ collection: "rooms", key, version: null }] },
      ...plan.milestones.map((m) => ({ op: "put", collection: "milestones", key: m.key, parentKey: key, data: { title: m.title, order: m.order, dueOn: m.dueOn } }) as Intent),
      ...plan.steps.map((s) => ({ op: "put", collection: "steps", parentKey: key, data: s }) as Intent),
    ];
    return { intents, value: { key, steps: plan.steps.length, toConfirm: plan.steps.filter((s) => s.ownerToConfirm).length } };
  },

  assignOwners(_ctx, reads) {
    const room = (reads.room as ReadDoc | null) ?? fail("That room doesn't exist, or it isn't yours to see.");
    if (room.data.status !== "draft" && room.data.status !== "live") fail("This room is closed.");
    const intents: Intent[] = [];
    for (const s of reads.steps as ReadDoc[]) {
      if (!s.data.ownerToConfirm || s.data.status !== "open") continue;
      const o = resolveOwner(s.data.ownerRole as string | undefined, s.data.side as Side, teamOf(room), stakeholdersOf(room));
      if (o.ownerToConfirm) continue;
      intents.push({ op: "patch", collection: "steps", key: s.key, data: o, expect: [{ collection: "steps", key: s.key, version: s.version }, { collection: "rooms", key: room.key, version: room.version }] });
    }
    return { intents, value: { assigned: intents.length } };
  },

  reorderSteps(ctx, reads) {
    return { intents: reorder("steps", reads.steps as ReadDoc[], (ctx.args.keys ?? []) as string[]) };
  },

  reorderTemplateSteps(ctx, reads) {
    return { intents: reorder("templateSteps", reads.steps as ReadDoc[], (ctx.args.keys ?? []) as string[]) };
  },

  rooms(ctx, reads) {
    const deals = new Map((reads.deals as Deal[]).map((d) => [d.id, d]));
    const stepsBy = new Map<string, ReadDoc[]>();
    for (const s of reads.steps as ReadDoc[]) stepsBy.set(s.parentKey!, [...(stepsBy.get(s.parentKey!) ?? []), s]);
    const day = today(ctx);
    const rows = (reads.rooms as ReadDoc[]).map((r) => {
      const deal = deals.get(r.data.deal as string);
      const f = stepFigures(figuresOf(stepsBy.get(r.key) ?? []), day, kindOf(r));
      return {
        key: r.key, title: r.data.title, kind: r.data.kind, kindLabel: KIND[r.data.kind as string] ?? null, status: r.data.status, statusLabel: STATUS[r.data.status as string] ?? null,
        rep: r.data.rep, health: r.data.health ?? null, healthLabel: HEALTH[r.data.health as string] ?? null,
        slipDays: r.data.slipDays ?? null, slipText: typeof r.data.slipDays === "number" && r.data.slipDays > 0 ? `${plural(r.data.slipDays, "day")} late` : null,
        lastBuyerAt: r.data.lastBuyerAt ?? null,
        deal: r.data.deal, dealName: deal?.name ?? null, companyName: deal?.companyName ?? null, amount: deal?.amount ?? null, closeDate: deal?.closeDate ?? null,
        progress: f.progress, progressText: `${f.done} of ${f.total}`, overdue: f.overdue, overdueText: f.overdue ? `${plural(f.overdue, "step")} overdue` : null, nextDue: f.nextDue ?? null,
      };
    });
    const live = rows.filter((r) => r.status === "live");
    return { value: { rows, live: live.length, open: rows.filter((r) => r.status === "draft" || r.status === "live").length, overdue: rows.reduce((n, r) => n + (r.status === "draft" || r.status === "live" ? r.overdue : 0), 0) } };
  },

  roomFigures(ctx, reads) {
    const room = reads.room as ReadDoc | null;
    if (!room) return { value: null };
    const f = stepFigures(figuresOf(reads.steps as ReadDoc[]), today(ctx), kindOf(room));
    const toConfirm = (reads.steps as ReadDoc[]).filter((s) => s.data.ownerToConfirm && s.data.status === "open").length;
    return { value: { ...f, slipBanner: slipBanner(Number(room.data.slipDays ?? 0)), healthLabel: HEALTH[room.data.health as string] ?? null, progressText: `${f.done} of ${f.total}`, nextDue: f.nextDue ?? null, toConfirm, ownersWaiting: toConfirm ? `${plural(toConfirm, "step")} ${toConfirm === 1 ? "waits" : "wait"} for an owner. Add the buyer's people on the People tab, or set an owner on the step.` : null } };
  },
};
