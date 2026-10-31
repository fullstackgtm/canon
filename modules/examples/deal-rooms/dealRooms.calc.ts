
export type Side = "seller" | "buyer" | "both";
export type SellerMember = { member: string; role: string };
export type Stakeholder = { name: string; email?: string; title?: string; slot?: string; contactId?: string };
export type TemplateStep = { title: string; detail?: string; milestoneTitle: string; side: Side; daysBeforeClose: number; ownerRole?: string; order: number };
export type StepStatus = "open" | "done" | "skipped";
export type StepFigures = { dueOn?: string; afterClose?: boolean; status: StepStatus; side: Side };

const DAY = 86_400_000;
export const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
export const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY);
export const dateOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

const norm = (s: string | undefined) => (s ?? "").trim().toLowerCase();

export type Owner = { sellerOwner?: string; buyerOwnerName?: string; buyerOwnerEmail?: string; ownerToConfirm: boolean };

export function resolveOwner(role: string | undefined, side: Side, team: SellerMember[], people: Stakeholder[]): Owner {
  const r = norm(role);
  if (!r) return { ownerToConfirm: true };
  const seller = team.find((m) => norm(m.role) === r);
  const buyer = people.find((p) => norm(p.slot) === r);
  const asSeller = (): Owner | null => (seller ? { sellerOwner: seller.member, ownerToConfirm: false } : null);
  const asBuyer = (): Owner | null => (buyer ? { buyerOwnerName: buyer.name, ...(buyer.email ? { buyerOwnerEmail: buyer.email } : {}), ownerToConfirm: false } : null);
  return (side === "seller" ? asSeller() ?? asBuyer() : asBuyer() ?? asSeller()) ?? { ownerToConfirm: true };
}

export type PlannedMilestone = { key: string; title: string; order: number; dueOn: string };
export type PlannedStep = Owner & {
  title: string; detail?: string; milestone: string; side: Side; ownerRole?: string; dueOn: string; afterClose: boolean; order: number;
};

export function planFromTemplate(roomKey: string, closeDate: string, template: TemplateStep[], team: SellerMember[], people: Stakeholder[]) {
  const ordered = [...template].sort((a, b) => a.order - b.order);
  const milestones: PlannedMilestone[] = [];
  const byTitle = new Map<string, PlannedMilestone>();
  const steps: PlannedStep[] = ordered.map((t, i) => {
    let m = byTitle.get(t.milestoneTitle);
    const dueOn = addDays(closeDate, -t.daysBeforeClose);
    if (!m) {
      m = { key: `${roomKey}|m${milestones.length + 1}`, title: t.milestoneTitle, order: milestones.length + 1, dueOn };
      milestones.push(m);
      byTitle.set(t.milestoneTitle, m);
    }
    if (dueOn > m.dueOn) m.dueOn = dueOn;
    return {
      title: t.title, ...(t.detail ? { detail: t.detail } : {}), milestone: m.key, side: t.side, ...(t.ownerRole ? { ownerRole: t.ownerRole } : {}),
      dueOn, afterClose: t.daysBeforeClose < 0, order: i + 1, ...resolveOwner(t.ownerRole, t.side, team, people),
    };
  });
  return { milestones, steps };
}

export function stepFigures(steps: StepFigures[], today: string, kind: "close" | "onboarding" = "close") {
  const counted = steps.filter((s) => (kind === "onboarding" || !s.afterClose) && s.status !== "skipped");
  const done = counted.filter((s) => s.status === "done").length;
  const open = steps.filter((s) => s.status === "open");
  const overdue = open.filter((s) => s.dueOn !== undefined && s.dueOn < today).length;
  const nextDue = open.map((s) => s.dueOn).filter((d): d is string => d !== undefined).sort()[0];
  return { done, total: counted.length, progress: counted.length ? done / counted.length : 0, open: open.length, overdue, ...(nextDue ? { nextDue } : {}) };
}

export type RoomAssessment = {
  steps: StepFigures[]; now: number; closeDate?: string | null; kind: "close" | "onboarding";
  status: string; lastBuyerAt?: number; linksIssued?: number;
};

export function assessRoom(input: RoomAssessment) {
  const today = dateOf(input.now);
  const figures = stepFigures(input.steps, today, input.kind);
  const planEnd = input.steps.filter((s) => !s.afterClose && s.status !== "skipped")
    .map((s) => s.dueOn).filter((d): d is string => d !== undefined).sort().at(-1);
  const slipDays = planEnd && input.closeDate ? Math.max(0, daysBetween(input.closeDate, planEnd)) : 0;
  const buyerOverdueMax = Math.max(0, ...input.steps.filter((s) => s.status === "open" && s.side !== "seller" && s.dueOn)
    .map((s) => daysBetween(s.dueOn!, today)));
  const quietDays = input.lastBuyerAt === undefined ? null : Math.max(0, Math.floor((input.now - input.lastBuyerAt) / DAY));
  const health = slipDays > 0 || buyerOverdueMax > 7 || (quietDays !== null && quietDays > 14 && input.status === "live" && (input.linksIssued ?? 0) > 0)
    ? "at_risk" : figures.overdue > 0 || (quietDays !== null && quietDays > 7) ? "needs_attention" : "on_track";
  return { ...figures, planEnd: planEnd ?? null, slipDays, buyerOverdueMax, quietDays, health };
}

export const slipBanner = (days: number) => days > 0 ? `Plan ends ${days} ${days === 1 ? "day" : "days"} after the close date.` : null;
