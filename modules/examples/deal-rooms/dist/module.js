var DAY = 864e5;
var addDays = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
var daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY);
var dateOf = (ms) => new Date(ms).toISOString().slice(0, 10);
var norm = (s) => (s ?? "").trim().toLowerCase();
function resolveOwner(role, side, team, people) {
  const r = norm(role);
  if (!r) return { ownerToConfirm: true };
  const seller = team.find((m) => norm(m.role) === r);
  const buyer = people.find((p) => norm(p.slot) === r);
  const asSeller = () => seller ? { sellerOwner: seller.member, ownerToConfirm: false } : null;
  const asBuyer = () => buyer ? { buyerOwnerName: buyer.name, ...buyer.email ? { buyerOwnerEmail: buyer.email } : {}, ownerToConfirm: false } : null;
  return (side === "seller" ? asSeller() ?? asBuyer() : asBuyer() ?? asSeller()) ?? { ownerToConfirm: true };
}
function planFromTemplate(roomKey, closeDate, template, team, people) {
  const ordered = [...template].sort((a, b) => a.order - b.order);
  const milestones = [];
  const byTitle = /* @__PURE__ */ new Map();
  const steps = ordered.map((t, i) => {
    let m = byTitle.get(t.milestoneTitle);
    const dueOn = addDays(closeDate, -t.daysBeforeClose);
    if (!m) {
      m = { key: `${roomKey}|m${milestones.length + 1}`, title: t.milestoneTitle, order: milestones.length + 1, dueOn };
      milestones.push(m);
      byTitle.set(t.milestoneTitle, m);
    }
    if (dueOn > m.dueOn) m.dueOn = dueOn;
    return {
      title: t.title,
      ...t.detail ? { detail: t.detail } : {},
      milestone: m.key,
      side: t.side,
      ...t.ownerRole ? { ownerRole: t.ownerRole } : {},
      dueOn,
      afterClose: t.daysBeforeClose < 0,
      order: i + 1,
      ...resolveOwner(t.ownerRole, t.side, team, people)
    };
  });
  return { milestones, steps };
}
function stepFigures(steps, today2, kind = "close") {
  const counted = steps.filter((s) => (kind === "onboarding" || !s.afterClose) && s.status !== "skipped");
  const done = counted.filter((s) => s.status === "done").length;
  const open = steps.filter((s) => s.status === "open");
  const overdue = open.filter((s) => s.dueOn !== void 0 && s.dueOn < today2).length;
  const nextDue = open.map((s) => s.dueOn).filter((d) => d !== void 0).sort()[0];
  return { done, total: counted.length, progress: counted.length ? done / counted.length : 0, open: open.length, overdue, ...nextDue ? { nextDue } : {} };
}
function assessRoom(input) {
  const today2 = dateOf(input.now);
  const figures = stepFigures(input.steps, today2, input.kind);
  const planEnd = input.steps.filter((s) => !s.afterClose && s.status !== "skipped").map((s) => s.dueOn).filter((d) => d !== void 0).sort().at(-1);
  const slipDays = planEnd && input.closeDate ? Math.max(0, daysBetween(input.closeDate, planEnd)) : 0;
  const buyerOverdueMax = Math.max(0, ...input.steps.filter((s) => s.status === "open" && s.side !== "seller" && s.dueOn).map((s) => daysBetween(s.dueOn, today2)));
  const quietDays = input.lastBuyerAt === void 0 ? null : Math.max(0, Math.floor((input.now - input.lastBuyerAt) / DAY));
  const health = slipDays > 0 || buyerOverdueMax > 7 || quietDays !== null && quietDays > 14 && input.status === "live" && (input.linksIssued ?? 0) > 0 ? "at_risk" : figures.overdue > 0 || quietDays !== null && quietDays > 7 ? "needs_attention" : "on_track";
  return { ...figures, planEnd: planEnd ?? null, slipDays, buyerOverdueMax, quietDays, health };
}
var slipBanner = (days) => days > 0 ? `Plan ends ${days} ${days === 1 ? "day" : "days"} after the close date.` : null;

var today = (ctx) => dateOf(ctx.now);
var fail = (message) => {
  throw new Error(message);
};
var SEED_TEMPLATES = [
  {
    key: "enterprise-close",
    name: "Enterprise close plan",
    kind: "close",
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
      { title: "Kickoff scheduled", milestoneTitle: "Kickoff", side: "seller", daysBeforeClose: -7, ownerRole: "Account executive" }
    ]
  },
  {
    key: "onboarding",
    name: "Onboarding plan",
    kind: "onboarding",
    description: "From the kickoff to the first value review, counted on from the close date.",
    steps: [
      { title: "Kickoff meeting held", milestoneTitle: "Kickoff", side: "both", daysBeforeClose: -7, ownerRole: "executive" },
      { title: "Admins named and invited", milestoneTitle: "Setup", side: "buyer", daysBeforeClose: -10, ownerRole: "champion" },
      { title: "Data imported", milestoneTitle: "Setup", side: "seller", daysBeforeClose: -14, ownerRole: "Account executive" },
      { title: "Integrations connected", milestoneTitle: "Setup", side: "both", daysBeforeClose: -21, ownerRole: "champion" },
      { title: "Team trained", milestoneTitle: "Adoption", side: "seller", daysBeforeClose: -28, ownerRole: "Account executive" },
      { title: "First value review", milestoneTitle: "Adoption", side: "both", daysBeforeClose: -45, ownerRole: "executive" }
    ]
  }
];
var stakeholdersOf = (room) => room.data.stakeholders ?? [];
var teamOf = (room) => room.data.sellerTeam ?? [];
var figuresOf = (steps) => steps.map((s) => s.data);
var kindOf = (room) => room.data.kind === "onboarding" ? "onboarding" : "close";
var HEALTH = { on_track: "On track", needs_attention: "Needs attention", at_risk: "At risk" };
var STATUS = { draft: "Draft", live: "Live", won: "Won", lost: "Lost", archived: "Archived" };
var KIND = { close: "Close plan", onboarding: "Onboarding plan" };
var plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
function reorder(collection, docs, keys) {
  const byKey = new Map(docs.map((d) => [d.key, d]));
  return keys.flatMap((key, i) => {
    const d = byKey.get(key);
    return d && d.data.order !== i + 1 ? [{ op: "patch", collection, key, data: { order: i + 1 }, expect: [{ collection, key, version: d.version }] }] : [];
  });
}
var isOpen = (room) => room.data.status === "draft" || room.data.status === "live";
var dirtyRooms = (rooms) => rooms.filter(isOpen).map((r) => ({ op: "dirty", job: "health", key: r.key }));
var calls = {
  onDeals(ctx) {
    const ids = [...new Set((ctx.args.changes ?? []).map((c) => c.id))];
    return { intents: ids.flatMap((id) => ["close", "onboarding"].map((kind) => ({ op: "dirty", job: "health", key: `${id}|${kind}` }))) };
  },
  health(ctx, reads) {
    const rooms = new Map(reads.rooms.map((r) => [r.key, r]));
    const deals = new Map(reads.deals.map((d) => [d.id, d]));
    const byKey = {};
    for (const key of ctx.args.keys) {
      const room = rooms.get(key);
      const deal = room && deals.get(room.data.deal);
      if (!room || !isOpen(room) || !deal) {
        byKey[key] = [];
        continue;
      }
      const steps = reads.steps.filter((s) => s.parentKey === key);
      const expect = [{ collection: "rooms", key, version: room.version }, ...steps.map((s) => ({ collection: "steps", key: s.key, version: s.version }))];
      const f = assessRoom({ steps: figuresOf(steps), now: ctx.now, closeDate: deal.closeDate, kind: kindOf(room), status: room.data.status, lastBuyerAt: room.data.lastBuyerAt });
      const values = { health: f.health, progress: f.progress, slipDays: f.slipDays, overdue: f.overdue, buyerOverdueMax: f.buyerOverdueMax, planEnd: f.planEnd, nextDue: f.nextDue ?? null, quietDays: f.quietDays, targetDate: deal.closeDate ?? null, ...deal.ownerId ? { rep: deal.ownerId } : {} };
      const data = Object.fromEntries(Object.entries(values).filter(([k, v]) => v !== null && room.data[k] !== v));
      const unset = Object.keys(values).filter((k) => values[k] === null && room.data[k] !== void 0);
      const intents = Object.keys(data).length || unset.length ? [{ op: "patch", collection: "rooms", key, data, unset, expect }] : [];
      if (deal.isClosed) intents.push({ op: "transition", machine: "room", name: deal.isWon ? "closeWon" : "closeLost", key, expect });
      byKey[key] = intents;
    }
    return { byKey };
  },
  hourly(_ctx, reads) {
    return { intents: dirtyRooms(reads.rooms) };
  },
  daily(ctx, reads) {
    const rooms = reads.rooms.filter(isOpen);
    const tomorrow = addDays(today(ctx), 1);
    const intents = dirtyRooms(rooms);
    for (const room of rooms) {
      const counts = /* @__PURE__ */ new Map();
      for (const step of reads.steps) {
        const d = step.data;
        if (step.parentKey !== room.key || d.status !== "open" || d.dueOn !== tomorrow || d.side === "buyer" || typeof d.sellerOwner !== "string") continue;
        counts.set(d.sellerOwner, (counts.get(d.sellerOwner) ?? 0) + 1);
      }
      for (const [owner, count] of counts) intents.push({ op: "notify", to: [owner], subject: "Deal room steps due tomorrow", message: `${String(room.data.title).slice(0, 200)}: ${plural(count, "step")} due tomorrow.`, link: `rooms/${encodeURIComponent(room.key)}?view=plan`, badge: "Deal room" });
    }
    return { intents };
  },
  digest(ctx, reads) {
    const rooms = reads.rooms;
    const open = rooms.filter(isOpen);
    const keys = new Set(open.map((r) => r.key));
    const steps = reads.steps.filter((s) => keys.has(s.parentKey));
    return { value: { live: rooms.filter((r) => r.data.status === "live").length, atRisk: open.filter((r) => r.data.health === "at_risk").length, overdue: stepFigures(figuresOf(steps), today(ctx)).overdue, buyerActions: null, buyerActivity: "Buyer activity is not available yet." } };
  },
  seedTemplates(_ctx, reads) {
    const have = new Set(reads.templates.map((t) => t.key));
    const intents = [];
    for (const t of SEED_TEMPLATES.filter((x) => !have.has(x.key))) {
      intents.push({ op: "put", collection: "templates", key: t.key, data: { name: t.name, kind: t.kind, description: t.description, active: true }, expect: [{ collection: "templates", key: t.key, version: null }] });
      t.steps.forEach((s, i) => intents.push({ op: "put", collection: "templateSteps", parentKey: t.key, data: { ...s, order: i + 1 } }));
    }
    return { intents, value: { added: intents.filter((i) => i.op === "put" && i.collection === "templates").length } };
  },
  fromTemplate(ctx, reads) {
    const template = reads.template;
    const deal = reads.deal[0];
    if (!template) fail("That template doesn't exist, or it isn't yours to see.");
    if (!deal) fail("That deal doesn't exist, or it isn't yours to see.");
    if (template.data.active === false) fail(`${template.data.name} is turned off.`);
    const kind = template.data.kind;
    if (reads.existing.some((r) => r.data.kind === kind)) fail(`${deal.name ?? "This deal"} already has a ${kind === "close" ? "close" : "onboarding"} room.`);
    if (!deal.closeDate) fail(`Set ${deal.name ?? "the deal"}'s close date first: the plan's dates count back from it.`);
    const tsteps = reads.steps.map((d) => d.data);
    if (!tsteps.length) fail(`${template.data.name} has no steps yet.`);
    const rep = deal.ownerId ?? ctx.caller.userId;
    const team = [{ member: rep, role: "Account executive" }];
    const people = (ctx.args.stakeholders ?? []).filter((p) => p.name?.trim());
    const key = `${deal.id}|${kind}`;
    const plan = planFromTemplate(key, deal.closeDate, tsteps, team, people);
    const assessment = assessRoom({ steps: plan.steps.map((s) => ({ ...s, status: "open" })), now: ctx.now, closeDate: deal.closeDate, kind, status: "draft" });
    const title = ctx.args.title?.trim() || `${deal.name ?? "Deal"}: ${kind === "close" ? "mutual action plan" : "onboarding plan"}`;
    const intents = [
      { op: "put", collection: "rooms", key, data: { deal: deal.id, kind, rep, title, template: template.data.name, sellerTeam: team, stakeholders: people, targetDate: deal.closeDate, health: assessment.health, progress: assessment.progress, slipDays: assessment.slipDays, overdue: assessment.overdue }, expect: [{ collection: "rooms", key, version: null }] },
      ...plan.milestones.map((m) => ({ op: "put", collection: "milestones", key: m.key, parentKey: key, data: { title: m.title, order: m.order, dueOn: m.dueOn } })),
      ...plan.steps.map((s) => ({ op: "put", collection: "steps", parentKey: key, data: s }))
    ];
    return { intents, value: { key, steps: plan.steps.length, toConfirm: plan.steps.filter((s) => s.ownerToConfirm).length } };
  },
  assignOwners(_ctx, reads) {
    const room = reads.room ?? fail("That room doesn't exist, or it isn't yours to see.");
    if (room.data.status !== "draft" && room.data.status !== "live") fail("This room is closed.");
    const intents = [];
    for (const s of reads.steps) {
      if (!s.data.ownerToConfirm || s.data.status !== "open") continue;
      const o = resolveOwner(s.data.ownerRole, s.data.side, teamOf(room), stakeholdersOf(room));
      if (o.ownerToConfirm) continue;
      intents.push({ op: "patch", collection: "steps", key: s.key, data: o, expect: [{ collection: "steps", key: s.key, version: s.version }, { collection: "rooms", key: room.key, version: room.version }] });
    }
    return { intents, value: { assigned: intents.length } };
  },
  reorderSteps(ctx, reads) {
    return { intents: reorder("steps", reads.steps, ctx.args.keys ?? []) };
  },
  reorderTemplateSteps(ctx, reads) {
    return { intents: reorder("templateSteps", reads.steps, ctx.args.keys ?? []) };
  },
  rooms(ctx, reads) {
    const deals = new Map(reads.deals.map((d) => [d.id, d]));
    const stepsBy = /* @__PURE__ */ new Map();
    for (const s of reads.steps) stepsBy.set(s.parentKey, [...stepsBy.get(s.parentKey) ?? [], s]);
    const day = today(ctx);
    const rows = reads.rooms.map((r) => {
      const deal = deals.get(r.data.deal);
      const f = stepFigures(figuresOf(stepsBy.get(r.key) ?? []), day, kindOf(r));
      return {
        key: r.key,
        title: r.data.title,
        kind: r.data.kind,
        kindLabel: KIND[r.data.kind] ?? null,
        status: r.data.status,
        statusLabel: STATUS[r.data.status] ?? null,
        rep: r.data.rep,
        health: r.data.health ?? null,
        healthLabel: HEALTH[r.data.health] ?? null,
        slipDays: r.data.slipDays ?? null,
        slipText: typeof r.data.slipDays === "number" && r.data.slipDays > 0 ? `${plural(r.data.slipDays, "day")} late` : null,
        lastBuyerAt: r.data.lastBuyerAt ?? null,
        deal: r.data.deal,
        dealName: deal?.name ?? null,
        companyName: deal?.companyName ?? null,
        amount: deal?.amount ?? null,
        closeDate: deal?.closeDate ?? null,
        progress: f.progress,
        progressText: `${f.done} of ${f.total}`,
        overdue: f.overdue,
        overdueText: f.overdue ? `${plural(f.overdue, "step")} overdue` : null,
        nextDue: f.nextDue ?? null
      };
    });
    const live = rows.filter((r) => r.status === "live");
    return { value: { rows, live: live.length, open: rows.filter((r) => r.status === "draft" || r.status === "live").length, overdue: rows.reduce((n, r) => n + (r.status === "draft" || r.status === "live" ? r.overdue : 0), 0) } };
  },
  roomFigures(ctx, reads) {
    const room = reads.room;
    if (!room) return { value: null };
    const f = stepFigures(figuresOf(reads.steps), today(ctx), kindOf(room));
    const toConfirm = reads.steps.filter((s) => s.data.ownerToConfirm && s.data.status === "open").length;
    return { value: { ...f, slipBanner: slipBanner(Number(room.data.slipDays ?? 0)), healthLabel: HEALTH[room.data.health] ?? null, progressText: `${f.done} of ${f.total}`, nextDue: f.nextDue ?? null, toConfirm, ownersWaiting: toConfirm ? `${plural(toConfirm, "step")} ${toConfirm === 1 ? "waits" : "wait"} for an owner. Add the buyer's people on the People tab, or set an owner on the step.` : null } };
  }
};
export {
  SEED_TEMPLATES,
  calls
};
