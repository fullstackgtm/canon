/**
 * Sequences' server code (docs/modules.md, "Server code"), built into dist/module.js by
 * `node --experimental-strip-types scripts/build-module-examples.ts`. The computing is in engine.ts and the kit's
 * sequences.ts.
 */
import type { CallFunctions, Intent, ReadDoc, RecordChange } from "../../kernel/calls.ts";
import { firstDay, localDate, MANUAL_STEPS, plan, type Schedule, type Step, type StepKind } from "../../kernel/sequences.ts";
import { skipReasons, type Candidate } from "./engine.ts";

/** A schedule doc as the engine reads it; a sequence without one sends Mon–Fri 08:00–17:00 New York time. */
const scheduleOf = (doc: ReadDoc | null): Schedule => doc
  ? { days: ((doc.data.days as string[] | undefined) ?? []).map(Number), start: String(doc.data.start), end: String(doc.data.end), timeZone: String(doc.data.timeZone), holidays: (doc.data.holidays as string[] | undefined) ?? [] }
  : { days: [1, 2, 3, 4, 5], start: "08:00", end: "17:00", timeZone: "America/New_York", holidays: [] };

const KIND_LABEL: Record<StepKind, string> = {
  auto_email: "Automatic email", manual_email: "Manual email", linkedin_invite: "LinkedIn invite", linkedin_message: "LinkedIn message",
  linkedin_task: "LinkedIn task", call: "Call", task: "Task",
};

type Person = { id: string; name?: string | null; title?: string | null; email?: string | null; linkedinUrl?: string | null; companyId?: string | null };
/** Enrollments that count as active outreach to a person (one active sequence per person, plan §2). */
const ACTIVE = ["pending", "active", "held", "paused"];
/** Why a person was skipped, as the panel says it. */
const SKIP_LABEL: Record<string, string> = {
  suppressed: "they're on the do-not-contact list", active_elsewhere: "they're active in another sequence", no_email: "they have no email",
  no_linkedin: "they have no LinkedIn URL", enrolled_before: "they were in this sequence before", contacted_recently: "they were contacted recently",
  unresolved_field: "a merge field can't be filled for them",
};
/** The merge fields the module can check from a person's own record; Canon checks the rest when it renders a send. */
const CHECKABLE = [ "lastName", "name", "title"];
const fieldsOf = (p: Person): Candidate["fields"] => {
  const parts = (p.name ?? "").trim().split(/\s+/).filter(Boolean);
  return { name: p.name ?? null, firstName: parts[0] ?? null, lastName: parts.length > 1 ? parts[parts.length - 1] : null, title: p.title ?? null };
};
const stepsOf = (docs: ReadDoc[]) => docs.map((d) => d.data as unknown as Step & { position: number; note?: string; priority?: string }).sort((a, b) => a.position - b.position);
/** A job's one key, from `ctx.args.keys`. */
const oneKey = (ctx: { args: Record<string, unknown> }) => (ctx.args.keys as string[])[0];

const STATE_LABEL: Record<string, string> = { pending: "Pending", active: "Active", held: "Out of office", paused: "Paused", finished: "Finished" };
const FINISH_LABEL: Record<string, string> = {
  completed: "Completed", replied: "Replied", bounced: "Bounced", unsubscribed: "Unsubscribed", meeting: "Meeting booked", opportunity: "Opportunity", manual: "Finished by hand", failed: "Failed",
};
const tally = (values: string[], labels: Record<string, string>) => {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts].map(([k, count]) => ({ label: labels[k] ?? k, count }));
};

export const calls: CallFunctions = {
  recentPeople(_ctx, reads) {
    const people = new Map((reads.people as Person[]).map((p) => [p.id, p]));
    const seen = new Set<string>();
    const rows = [];
    for (const task of reads.tasks as ReadDoc[]) {
      const person = people.get(String(task.data.contact));
      if (!person || seen.has(person.id)) continue;
      seen.add(person.id);
      rows.push({ person: person.id, name: person.name ?? "Person record", title: person.title ?? null,
        company: person.companyId ?? null, companyLink: person.companyId ? "Company record" : null, callAt: task.data.callAt });
    }
    return { value: { rows } };
  },
  onCalls(ctx) {
    const keys = new Set<string>();
    for (const change of ctx.args.changes as RecordChange[]) {
      const a = change.after;
      if (!a || a.kind !== "call" || a.direction !== "outbound" || typeof a.ownerId !== "string" ||
        typeof a.at !== "number" || !Number.isFinite(a.at) || typeof a.outcome !== "string" ||
        !["connected", "no_answer", "left_voicemail", "busy", "wrong_number"].includes(a.outcome)) continue;
      const people = typeof a.personId === "string" ? [a.personId] : change.targets?.people ?? [];
      // Without a task correlation on the call, an ambiguous multi-person activity completes none.
      if (people.length !== 1) continue;
      keys.add(`${a.ownerId}|${people[0]}|${change.id}|${a.at}~${change.at}~${a.outcome}`);
    }
    return { intents: [...keys].map((key): Intent => ({ op: "dirty", job: "callLogged", key })) };
  },
  completeCall(ctx, reads) {
    const key = oneKey(ctx);
    const [atText, observedText, outcome] = String(ctx.args.result).split("~");
    const at = Number(atText), observedAt = Number(observedText);
    const activity = String(ctx.args.activity), rep = String(ctx.args.rep), contact = String(ctx.args.contact);
    const byKey: Record<string, Intent[]> = { [key]: [] };
    const logged = reads.logged as ReadDoc[];
    const enrollments = reads.enrollments as ReadDoc[];
    const eligible = (reads.tasks as ReadDoc[]).filter((t) => t.data.kind === "call" && t.data.state === "open" &&
      t.owner === rep && t.data.contact === contact && t.createdAt <= at && enrollments.some((e) =>
        e.data.sequence === t.data.sequence && Number(e.data.stepIndex) === Number(t.data.stepIndex) &&
        ["active", "paused"].includes(String(e.data.state))));
    // One activity can satisfy at most one step. Concurrent eligible tasks need an explicit correlation.
    const task = logged.length === 1 && logged[0].data.contact === contact && logged[0].owner === rep ? logged[0]
      : logged.length === 0 && eligible.length === 1 ? eligible[0] : null;
    if (!task || Number(task.data.callObservedAt ?? -1) >= observedAt) return { byKey };
    byKey[key].push({ op: "patch", collection: "tasks", key: task.key,
      data: { callActivity: activity, callAt: at, callOutcome: outcome, callObservedAt: observedAt },
      expect: [{ collection: "tasks", key: task.key, version: task.version }] });
    if (task.data.state === "open") byKey[key].push({ op: "transition", machine: "task", name: "callLogged", key: task.key });
    return { byKey };
  },
  /** A sequence's figures: its people by state and finish reason, and its tasks done, open and overdue (due before today, UTC). */
  sequenceStats(ctx, reads) {
    const enrollments = reads.enrollments as ReadDoc[];
    const tasks = reads.tasks as ReadDoc[];
    const today = new Date(ctx.now).toISOString().slice(0, 10);
    const open = tasks.filter((t) => t.data.state === "open");
    return { value: {
      enrolled: enrollments.length,
      active: enrollments.filter((e) => ["pending", "active", "held"].includes(String(e.data.state))).length,
      finished: enrollments.filter((e) => e.data.state === "finished").length,
      tasksDone: tasks.filter((t) => t.data.state === "done").length,
      tasksOpen: open.length,
      tasksOverdue: open.filter((t) => String(t.data.dueDay) < today).length,
      byState: tally(enrollments.map((e) => String(e.data.state)), STATE_LABEL),
      byFinish: tally(enrollments.filter((e) => e.data.finishReason).map((e) => String(e.data.finishReason)), FINISH_LABEL),
      byStep: tally(tasks.map((t) => `Step ${Number(t.data.stepIndex) + 1}`), {}).sort((a, b) => a.label.localeCompare(b.label)),
    } };
  },
  /**
   * One person into a sequence from their page (plan §2, "one contact"), through the same checks as an audience: no
   * email or LinkedIn URL for the steps' channels, active in another sequence, enrolled before, a name field it can't
   * fill. Into a running sequence they start now.
   */
  enrollOne(ctx, reads) {
    const sequence = reads.sequence as ReadDoc | null;
    const [person] = reads.person as Person[];
    if (!sequence || sequence.data.status === "archived") throw new Error("That sequence is archived or gone.");
    if (!person) throw new Error("You can't see that person.");
    const existing = reads.existing as ReadDoc[];
    const { skipped } = skipReasons([{ id: person.id, email: person.email, linkedinUrl: person.linkedinUrl, fields: fieldsOf(person) }], {
      suppressed: new Map(),
      activeElsewhere: new Set(existing.filter((e) => ACTIVE.includes(String(e.data.state))).map((e) => String(e.data.contact))),
      enrolledBefore: new Set(existing.filter((e) => e.data.sequence === sequence.key).map((e) => String(e.data.contact))),
      addPolicy: (sequence.data.addPolicy as "once" | "if_not_active" | "any" | undefined) ?? "once",
      lastContactedAt: new Map(), contactLatencyDays: 0, steps: stepsOf(reads.steps as ReadDoc[]), now: ctx.now, checkable: CHECKABLE,
    });
    if (skipped.length) throw new Error(`${person.name ?? "This person"} can't be added: ${SKIP_LABEL[skipped[0].reason]}.`);
    // One enrollment per person and sequence: re-adding someone who finished would overwrite their history, so it
    // waits for a re-enroll that keeps it (plan §4, `reenroll`), whatever the add policy says.
    if (existing.some((e) => e.data.sequence === sequence.key)) throw new Error(`${person.name ?? "This person"} was in this sequence before; adding them again isn't supported yet.`);
    return {
      intents: [{ op: "put", collection: "enrollments", data: {
        sequence: sequence.key, contact: person.id, stepIndex: 0, rep: ctx.caller.userId,
        ...(sequence.data.status === "active" ? { nextAt: ctx.now } : {}),
        ...(person.name ? { contactName: person.name } : {}), ...(person.title ? { title: person.title } : {}),
        ...(person.email ? { email: person.email } : {}), ...(person.linkedinUrl ? { linkedinUrl: person.linkedinUrl } : {}),
      } }],
      value: { message: `${person.name ?? "They"} ${sequence.data.status === "active" ? "start" : "will start when it launches"} in ${String(sequence.data.name)}` },
    };
  },
  /**
   * A launched (or resumed) sequence's people, 500 of each a run, due now: the pending ones start, and the active ones
   * with nothing scheduled wake, so a task done while it was paused moves them on. Each one patched leaves the views
   * (they read people without `nextAt`), so the next run reads the next 500.
   */
  launchSequence(ctx, reads) {
    const key = oneKey(ctx);
    const sequence = reads.sequence as ReadDoc | null;
    const pending = reads.pending as ReadDoc[];
    const idle = reads.idle as ReadDoc[];
    if (!sequence || sequence.data.status !== "active") return { byKey: { [key]: [] } };
    const intents: Intent[] = [...pending, ...idle].map((e) => ({ op: "patch", collection: "enrollments", key: e.key, data: { nextAt: ctx.now }, expect: [{ collection: "enrollments", key: e.key, version: e.version }] }));
    if (pending.length === 500 || idle.length === 500) intents.push({ op: "dirty", job: "launch", key });
    return { byKey: { [key]: intents } };
  },
  /**
   * Each due person's next step (plan §6): a step a rep does becomes a task on its day; once its task is done or
   * skipped, the person moves to the next step, planned from that day, or finishes after the last. Automatic steps
   * wait for Canon's outbox (launch refuses a sequence with one).
   */
  advance(ctx, reads) {
    const sequence = reads.sequence as ReadDoc | null;
    const steps = stepsOf((reads.steps as ReadDoc[]) ?? []);
    const s = scheduleOf(reads.schedule as ReadDoc | null);
    const interval = sequence?.data.intervalType === "calendar_days" ? "calendar_days" : "schedule_days";
    const byContact = new Map((reads.enrollments as ReadDoc[]).map((e) => [String(e.data.contact), e]));
    const tasks = reads.tasks as ReadDoc[];
    const byKey: Record<string, Intent[]> = {};
    for (const key of ctx.args.keys as string[]) {
      const contact = key.slice(key.indexOf("|") + 1);
      const e = byContact.get(contact);
      byKey[key] = [];
      if (!sequence || sequence.data.status !== "active" || !e || e.data.state !== "active") continue;
      const out = byKey[key];
      const expect = [{ collection: "enrollments", key: e.key, version: e.version }];
      let stepIndex = Number(e.data.stepIndex ?? 0);
      let lastDay = (e.data.lastDay as string | undefined) ?? null;
      // The first step counts its delay from the day the person started, kept, so a wake doesn't restart it.
      const startDay = (e.data.startDay as string | undefined) ?? firstDay(ctx.now, s);
      const task = tasks.find((t) => t.data.contact === contact && Number(t.data.stepIndex) === stepIndex);
      if (task?.data.state === "open") continue;
      if (task) {
        stepIndex += 1;
        lastDay = localDate(Number(task.data.doneAt ?? ctx.now), s.timeZone);
        if (stepIndex >= steps.length) {
          out.push({ op: "patch", collection: "enrollments", key: e.key, data: { stepIndex, lastDay }, expect });
          out.push({ op: "transition", machine: "enrollment", name: "complete", key: e.key });
          continue;
        }
      }
      const next = plan({ stepIndex, lastDay: lastDay ?? startDay }, steps, s, ctx.now, interval);
      if (next.done) continue;
      const step = steps[stepIndex];
      const due = next.nextAt <= ctx.now;
      out.push({ op: "patch", collection: "enrollments", key: e.key, expect,
        data: { stepIndex, startDay, ...(lastDay ? { lastDay } : {}), ...(due ? {} : { nextAt: next.nextAt }) }, ...(due ? { unset: ["nextAt"] } : {}) });
      if (due && MANUAL_STEPS.includes(step.kind)) {
        out.push({ op: "put", collection: "tasks", data: {
          sequence: sequence.key, contact, stepIndex, kind: step.kind, dueDay: next.day,
          ...(e.owner ? { rep: e.owner } : {}), ...(step.note ? { note: step.note } : {}), ...(step.priority ? { priority: step.priority } : {}),
          ...(e.data.contactName ? { contactName: e.data.contactName } : {}), ...(e.data.title ? { title: e.data.title } : {}),
          ...(e.data.email ? { email: e.data.email } : {}), ...(e.data.linkedinUrl ? { linkedinUrl: e.data.linkedinUrl } : {}),
        } });
      }
    }
    return { byKey };
  },
  /** The audiences the caller can see, to add people from. */
  audienceList(_ctx, reads) {
    return { value: { audiences: reads.audiences } };
  },
  /**
   * Add people: the audience frozen now (docs/modules.md, "Audiences") as an enroll run, whose create dirties the
   * `snap` job's page 0. Nobody is enrolled until a person looks at the check and confirms.
   */
  startEnroll(ctx, reads) {
    const sequence = reads.sequence as ReadDoc | null;
    if (!sequence || sequence.data.status === "archived") throw new Error("That sequence is archived or gone.");
    const snap = (reads.snapshot as Array<{ id: string; count: number; pages: number }>)[0];
    const audience = (reads.audiences as Array<{ id: string; name: string }>).find((a) => a.id === ctx.args.audience);
    const data = { sequence: sequence.key, snapshot: snap.id, audience: String(ctx.args.audience), audienceName: audience?.name ?? "Audience", count: snap.count, pages: snap.pages };
    return { intents: [{ op: "op", name: "enrollRuns.create", data }], value: { key: snap.id, count: snap.count } };
  },
  /** One page of the audience copied into the run, then checked; page 0 reads the other pages too. */
  snapPage(ctx, reads) {
    const key = oneKey(ctx);
    const run = reads.run as ReadDoc | null;
    if (!run) return { byKey: { [key]: [] } };
    const page = String(ctx.args.page);
    const people = (reads.people as Person[]).map((p) => ({ id: p.id, ...(p.name ? { name: p.name } : {}), ...(p.title ? { title: p.title } : {}), ...(p.email ? { email: p.email } : {}), ...(p.linkedinUrl ? { linkedinUrl: p.linkedinUrl } : {}) }));
    const intents: Intent[] = [
      { op: "put", collection: "enrollPages", data: { run: run.key, page, ids: people.map((p) => p.id), people, nPeople: people.length } },
      { op: "dirty", job: "check", key: `${run.key}|${page}` },
    ];
    if (page === "0") for (let n = 1; n < Number(run.data.pages); n++) intents.push({ op: "dirty", job: "snap", key: `${run.key}|${n}` });
    return { byKey: { [key]: intents } };
  },
  /** Who on one page to skip and why (engine `skipReasons`): suppression and LinkedIn cadences wait for Canon's reads. */
  checkPage(ctx, reads) {
    const key = oneKey(ctx);
    const [sheet] = reads.sheet as ReadDoc[];
    const sequence = reads.sequence as ReadDoc | null;
    if (!sheet || !sequence) return { byKey: { [key]: [] } };
    const people = (sheet.data.people as Person[] | undefined) ?? [];
    const existing = reads.existing as ReadDoc[];
    const { enroll, skipped } = skipReasons(people.map((p) => ({ id: p.id, email: p.email, linkedinUrl: p.linkedinUrl, fields: fieldsOf(p) })), {
      suppressed: new Map(),
      activeElsewhere: new Set(existing.filter((e) => ACTIVE.includes(String(e.data.state))).map((e) => String(e.data.contact))),
      enrolledBefore: new Set(existing.filter((e) => e.data.sequence === sequence.key).map((e) => String(e.data.contact))),
      addPolicy: (sequence.data.addPolicy as "once" | "if_not_active" | "any" | undefined) ?? "once",
      lastContactedAt: new Map(), contactLatencyDays: 0, steps: stepsOf(reads.steps as ReadDoc[]), now: ctx.now, checkable: CHECKABLE,
    });
    const names = new Map(people.map((p) => [p.id, p.name]));
    const run = reads.run as ReadDoc | null;
    const intents: Intent[] = [{
      op: "patch", collection: "enrollPages", key: sheet.key, expect: [{ collection: "enrollPages", key: sheet.key, version: sheet.version }],
      data: { enroll, skipped: skipped.map((s) => ({ ...s, ...(names.get(s.id) ? { name: names.get(s.id) } : {}) })), nEnroll: enroll.length, nSkipped: skipped.length },
    }];
    // Confirmed before this page was checked: its enrollment waited on this check, so the check starts it.
    if (run?.data.status === "enrolling") intents.push({ op: "dirty", job: "enroll", key: `${run.key}|${String(ctx.args.page)}` });
    return { byKey: { [key]: intents } };
  },
  /**
   * One checked page enrolled, after the run was confirmed: anyone who became active elsewhere since is left out. A page
   * not copied or checked yet does nothing here; its check dirties this key again when it finishes, so the order of
   * confirming and checking never loses anyone. Page 0 dirties the other pages.
   */
  enrollPage(ctx, reads) {
    const key = oneKey(ctx);
    const run = reads.run as ReadDoc | null;
    const [sheet] = reads.sheet as ReadDoc[];
    const sequence = reads.sequence as ReadDoc | null;
    const rest: Intent[] = run && String(ctx.args.page) === "0" ? Array.from({ length: Math.max(0, Number(run.data.pages) - 1) }, (_, i) => ({ op: "dirty" as const, job: "enroll", key: `${run.key}|${i + 1}` })) : [];
    if (!run || !sequence || run.data.status !== "enrolling") return { byKey: { [key]: [] } };
    if (!sheet || !Array.isArray(sheet.data.enroll)) return { byKey: { [key]: rest } };
    const taken = new Set((reads.existing as ReadDoc[]).filter((e) => ACTIVE.includes(String(e.data.state)) || e.data.sequence === sequence.key).map((e) => String(e.data.contact)));
    const people = new Map(((sheet.data.people as Person[] | undefined) ?? []).map((p) => [p.id, p]));
    const ids = ((sheet.data.enroll as string[] | undefined) ?? []).filter((id) => !taken.has(id));
    const intents: Intent[] = ids.map((id) => {
      const p = people.get(id);
      return { op: "put", collection: "enrollments", data: {
        sequence: sequence.key, contact: id, stepIndex: 0, run: run.key,
        // Into a running sequence: it starts now. Otherwise Launch starts it.
        ...(sequence.data.status === "active" ? { nextAt: ctx.now } : {}),
        ...(sequence.owner ? { rep: sequence.owner } : {}), ...(p?.name ? { contactName: p.name } : {}), ...(p?.title ? { title: p.title } : {}),
        ...(p?.email ? { email: p.email } : {}), ...(p?.linkedinUrl ? { linkedinUrl: p.linkedinUrl } : {}),
      } };
    });
    intents.push({ op: "patch", collection: "enrollPages", key: sheet.key, data: { nEnrolled: ids.length + Number(sheet.data.nEnrolled ?? 0) } }, ...rest);
    return { byKey: { [key]: intents } };
  },
  /** The steps in the order dragged: each moved step's position, 1 up, checked against the order the page read. */
  reorderSteps(ctx, reads) {
    const steps = reads.steps as ReadDoc[];
    const keys = (ctx.args.keys as string[]) ?? [];
    const byKey = new Map(steps.map((s) => [s.key, s]));
    if (keys.length !== steps.length || keys.some((k) => !byKey.has(k))) throw new Error("The steps changed since the page read them. Reload and drag again.");
    const intents: Intent[] = keys.flatMap((key, i) => {
      const step = byKey.get(key)!;
      return step.data.position === i + 1 ? [] : [{ op: "patch" as const, collection: "steps", key, data: { position: i + 1 }, expect: [{ collection: "steps", key, version: step.version }] }];
    });
    return { intents, value: { moved: intents.length } };
  },
  /** The day each step would go out for someone enrolled now, with no outcome stopping them and every task done on its day. */
  timeline(ctx, reads) {
    const sequence = reads.sequence as ReadDoc | null;
    const steps = ((reads.steps as ReadDoc[]) ?? []).map((d) => d.data as unknown as Step & { position: number }).sort((a, b) => a.position - b.position);
    if (!sequence) return { value: { rows: [] } };
    const s = scheduleOf(reads.schedule as ReadDoc | null);
    const interval = sequence.data.intervalType === "calendar_days" ? "calendar_days" : "schedule_days";
    const rows: Array<{ n: number; kind: string; day: string; who: string }> = [];
    let lastDay: string | null = null;
    for (let i = 0; i < steps.length; i++) {
      const next = plan({ stepIndex: i, lastDay }, steps, s, ctx.now, interval);
      if (next.done) break;
      rows.push({ n: i + 1, kind: KIND_LABEL[steps[i].kind], day: next.day, who: MANUAL_STEPS.includes(steps[i].kind) ? "The rep, from their task inbox" : "Canon, from the sender" });
      lastDay = next.day;
    }
    return { value: { rows } };
  },
};
