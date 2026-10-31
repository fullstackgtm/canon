var MANUAL_STEPS = ["manual_email", "linkedin_task", "call", "task"];
var DAY_MS = 864e5;
var parts = (ms, timeZone) => {
  const p = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(ms));
  const get = (t) => Number(p.find((x) => x.type === t)?.value);
  return { y: get("year"), m: get("month"), d: get("day"), h: get("hour"), min: get("minute"), s: get("second") };
};
function localDate(ms, timeZone) {
  const { y, m, d } = parts(ms, timeZone);
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}
var minutesOf = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
function zonedMs(date, hhmm, timeZone) {
  const guess = Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)), 0, minutesOf(hhmm));
  const offset = (ms) => {
    const p = parts(ms, timeZone);
    return Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s) - Math.floor(ms / 1e3) * 1e3;
  };
  const first = guess - offset(guess);
  return guess - offset(first);
}
var addDays = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
var weekday = (date) => (/* @__PURE__ */ new Date(`${date}T00:00:00Z`)).getUTCDay();
var isOpenDay = (date, s) => s.days.includes(weekday(date)) && !s.holidays.includes(date);
function nextOpenDay(date, s) {
  let d = date;
  for (let i = 0; i < 400 && !isOpenDay(d, s); i++) d = addDays(d, 1);
  return d;
}
function addScheduleDays(date, n, s) {
  let d = nextOpenDay(date, s);
  for (let i = 0; i < n; i++) d = nextOpenDay(addDays(d, 1), s);
  return d;
}
function firstDay(now, s) {
  const today = localDate(now, s.timeZone);
  const { h, min } = parts(now, s.timeZone);
  return isOpenDay(today, s) && h * 60 + min < minutesOf(s.end) ? today : nextOpenDay(addDays(today, 1), s);
}
function plan(pos, steps, s, now, interval = "schedule_days") {
  const step = steps[pos.stepIndex];
  if (!step) return { done: true };
  const base = pos.lastDay ?? firstDay(now, s);
  const day = interval === "schedule_days" ? addScheduleDays(base, step.delayDays, s) : nextOpenDay(addDays(base, step.delayDays), s);
  return { done: false, stepIndex: pos.stepIndex, day, nextAt: Math.max(zonedMs(day, s.start, s.timeZone), now) };
}
var MERGE = /\{\{\s*([a-zA-Z][\w.]*)\s*(?:\|\s*default\s+"([^"]*)")?\s*\}\}/g;
function unresolvedFields(template, fields) {
  const out = [];
  for (const [, name, fallback] of template.matchAll(MERGE)) {
    const v = fields[name];
    if ((v === void 0 || v === null || v === "") && fallback === void 0 && !out.includes(name)) out.push(name);
  }
  return out;
}
function skipReasons(contacts, c) {
  const usesEmail = c.steps.some((s) => s.kind === "auto_email" || s.kind === "manual_email");
  const usesLinkedin = c.steps.some((s) => s.kind === "linkedin_invite" || s.kind === "linkedin_message");
  const templates = c.steps.flatMap((s) => (s.variants ?? []).flatMap((v) => [v.subject ?? "", v.body]));
  const enroll = [];
  const skipped = [];
  for (const p of contacts) {
    const last = c.lastContactedAt.get(p.id);
    const reason = c.suppressed.has(p.id) ? "suppressed" : c.activeElsewhere.has(p.id) ? "active_elsewhere" : usesEmail && !p.email ? "no_email" : usesLinkedin && !p.linkedinUrl ? "no_linkedin" : c.enrolledBefore.has(p.id) && c.addPolicy === "once" ? "enrolled_before" : last !== void 0 && c.now - last < c.contactLatencyDays * DAY_MS ? "contacted_recently" : templates.some((t) => unresolvedFields(t, p.fields).some((f) => !c.checkable || c.checkable.includes(f))) ? "unresolved_field" : null;
    if (reason) skipped.push({ id: p.id, reason });
    else enroll.push(p.id);
  }
  return { enroll, skipped };
}

var scheduleOf = (doc) => doc ? { days: (doc.data.days ?? []).map(Number), start: String(doc.data.start), end: String(doc.data.end), timeZone: String(doc.data.timeZone), holidays: doc.data.holidays ?? [] } : { days: [1, 2, 3, 4, 5], start: "08:00", end: "17:00", timeZone: "America/New_York", holidays: [] };
var KIND_LABEL = {
  auto_email: "Automatic email",
  manual_email: "Manual email",
  linkedin_invite: "LinkedIn invite",
  linkedin_message: "LinkedIn message",
  linkedin_task: "LinkedIn task",
  call: "Call",
  task: "Task"
};
var ACTIVE = ["pending", "active", "held", "paused"];
var SKIP_LABEL = {
  suppressed: "they're on the do-not-contact list",
  active_elsewhere: "they're active in another sequence",
  no_email: "they have no email",
  no_linkedin: "they have no LinkedIn URL",
  enrolled_before: "they were in this sequence before",
  contacted_recently: "they were contacted recently",
  unresolved_field: "a merge field can't be filled for them"
};
var CHECKABLE = ["lastName", "name", "title"];
var fieldsOf = (p) => {
  const parts2 = (p.name ?? "").trim().split(/\s+/).filter(Boolean);
  return { name: p.name ?? null, firstName: parts2[0] ?? null, lastName: parts2.length > 1 ? parts2[parts2.length - 1] : null, title: p.title ?? null };
};
var stepsOf = (docs) => docs.map((d) => d.data).sort((a, b) => a.position - b.position);
var oneKey = (ctx) => ctx.args.keys[0];
var STATE_LABEL = { pending: "Pending", active: "Active", held: "Out of office", paused: "Paused", finished: "Finished" };
var FINISH_LABEL = {
  completed: "Completed",
  replied: "Replied",
  bounced: "Bounced",
  unsubscribed: "Unsubscribed",
  meeting: "Meeting booked",
  opportunity: "Opportunity",
  manual: "Finished by hand",
  failed: "Failed"
};
var tally = (values, labels) => {
  const counts = /* @__PURE__ */ new Map();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts].map(([k, count]) => ({ label: labels[k] ?? k, count }));
};
var calls = {
  recentPeople(_ctx, reads) {
    const people = new Map(reads.people.map((p) => [p.id, p]));
    const seen = /* @__PURE__ */ new Set();
    const rows = [];
    for (const task of reads.tasks) {
      const person = people.get(String(task.data.contact));
      if (!person || seen.has(person.id)) continue;
      seen.add(person.id);
      rows.push({
        person: person.id,
        name: person.name ?? "Person record",
        title: person.title ?? null,
        company: person.companyId ?? null,
        companyLink: person.companyId ? "Company record" : null,
        callAt: task.data.callAt
      });
    }
    return { value: { rows } };
  },
  onCalls(ctx) {
    const keys = /* @__PURE__ */ new Set();
    for (const change of ctx.args.changes) {
      const a = change.after;
      if (!a || a.kind !== "call" || a.direction !== "outbound" || typeof a.ownerId !== "string" || typeof a.at !== "number" || !Number.isFinite(a.at) || typeof a.outcome !== "string" || !["connected", "no_answer", "left_voicemail", "busy", "wrong_number"].includes(a.outcome)) continue;
      const people = typeof a.personId === "string" ? [a.personId] : change.targets?.people ?? [];
      if (people.length !== 1) continue;
      keys.add(`${a.ownerId}|${people[0]}|${change.id}|${a.at}~${change.at}~${a.outcome}`);
    }
    return { intents: [...keys].map((key) => ({ op: "dirty", job: "callLogged", key })) };
  },
  completeCall(ctx, reads) {
    const key = oneKey(ctx);
    const [atText, observedText, outcome] = String(ctx.args.result).split("~");
    const at = Number(atText), observedAt = Number(observedText);
    const activity = String(ctx.args.activity), rep = String(ctx.args.rep), contact = String(ctx.args.contact);
    const byKey = { [key]: [] };
    const logged = reads.logged;
    const enrollments = reads.enrollments;
    const eligible = reads.tasks.filter((t) => t.data.kind === "call" && t.data.state === "open" && t.owner === rep && t.data.contact === contact && t.createdAt <= at && enrollments.some((e) => e.data.sequence === t.data.sequence && Number(e.data.stepIndex) === Number(t.data.stepIndex) && ["active", "paused"].includes(String(e.data.state))));
    const task = logged.length === 1 && logged[0].data.contact === contact && logged[0].owner === rep ? logged[0] : logged.length === 0 && eligible.length === 1 ? eligible[0] : null;
    if (!task || Number(task.data.callObservedAt ?? -1) >= observedAt) return { byKey };
    byKey[key].push({
      op: "patch",
      collection: "tasks",
      key: task.key,
      data: { callActivity: activity, callAt: at, callOutcome: outcome, callObservedAt: observedAt },
      expect: [{ collection: "tasks", key: task.key, version: task.version }]
    });
    if (task.data.state === "open") byKey[key].push({ op: "transition", machine: "task", name: "callLogged", key: task.key });
    return { byKey };
  },
  /** A sequence's figures: its people by state and finish reason, and its tasks done, open and overdue (due before today, UTC). */
  sequenceStats(ctx, reads) {
    const enrollments = reads.enrollments;
    const tasks = reads.tasks;
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
      byStep: tally(tasks.map((t) => `Step ${Number(t.data.stepIndex) + 1}`), {}).sort((a, b) => a.label.localeCompare(b.label))
    } };
  },
  /**
   * One person into a sequence from their page (plan §2, "one contact"), through the same checks as an audience: no
   * email or LinkedIn URL for the steps' channels, active in another sequence, enrolled before, a name field it can't
   * fill. Into a running sequence they start now.
   */
  enrollOne(ctx, reads) {
    const sequence = reads.sequence;
    const [person] = reads.person;
    if (!sequence || sequence.data.status === "archived") throw new Error("That sequence is archived or gone.");
    if (!person) throw new Error("You can't see that person.");
    const existing = reads.existing;
    const { skipped } = skipReasons([{ id: person.id, email: person.email, linkedinUrl: person.linkedinUrl, fields: fieldsOf(person) }], {
      suppressed: /* @__PURE__ */ new Map(),
      activeElsewhere: new Set(existing.filter((e) => ACTIVE.includes(String(e.data.state))).map((e) => String(e.data.contact))),
      enrolledBefore: new Set(existing.filter((e) => e.data.sequence === sequence.key).map((e) => String(e.data.contact))),
      addPolicy: sequence.data.addPolicy ?? "once",
      lastContactedAt: /* @__PURE__ */ new Map(),
      contactLatencyDays: 0,
      steps: stepsOf(reads.steps),
      now: ctx.now,
      checkable: CHECKABLE
    });
    if (skipped.length) throw new Error(`${person.name ?? "This person"} can't be added: ${SKIP_LABEL[skipped[0].reason]}.`);
    if (existing.some((e) => e.data.sequence === sequence.key)) throw new Error(`${person.name ?? "This person"} was in this sequence before; adding them again isn't supported yet.`);
    return {
      intents: [{ op: "put", collection: "enrollments", data: {
        sequence: sequence.key,
        contact: person.id,
        stepIndex: 0,
        rep: ctx.caller.userId,
        ...sequence.data.status === "active" ? { nextAt: ctx.now } : {},
        ...person.name ? { contactName: person.name } : {},
        ...person.title ? { title: person.title } : {},
        ...person.email ? { email: person.email } : {},
        ...person.linkedinUrl ? { linkedinUrl: person.linkedinUrl } : {}
      } }],
      value: { message: `${person.name ?? "They"} ${sequence.data.status === "active" ? "start" : "will start when it launches"} in ${String(sequence.data.name)}` }
    };
  },
  /**
   * A launched (or resumed) sequence's people, 500 of each a run, due now: the pending ones start, and the active ones
   * with nothing scheduled wake, so a task done while it was paused moves them on. Each one patched leaves the views
   * (they read people without `nextAt`), so the next run reads the next 500.
   */
  launchSequence(ctx, reads) {
    const key = oneKey(ctx);
    const sequence = reads.sequence;
    const pending = reads.pending;
    const idle = reads.idle;
    if (!sequence || sequence.data.status !== "active") return { byKey: { [key]: [] } };
    const intents = [...pending, ...idle].map((e) => ({ op: "patch", collection: "enrollments", key: e.key, data: { nextAt: ctx.now }, expect: [{ collection: "enrollments", key: e.key, version: e.version }] }));
    if (pending.length === 500 || idle.length === 500) intents.push({ op: "dirty", job: "launch", key });
    return { byKey: { [key]: intents } };
  },
  /**
   * Each due person's next step (plan §6): a step a rep does becomes a task on its day; once its task is done or
   * skipped, the person moves to the next step, planned from that day, or finishes after the last. Automatic steps
   * wait for Canon's outbox (launch refuses a sequence with one).
   */
  advance(ctx, reads) {
    const sequence = reads.sequence;
    const steps = stepsOf(reads.steps ?? []);
    const s = scheduleOf(reads.schedule);
    const interval = sequence?.data.intervalType === "calendar_days" ? "calendar_days" : "schedule_days";
    const byContact = new Map(reads.enrollments.map((e) => [String(e.data.contact), e]));
    const tasks = reads.tasks;
    const byKey = {};
    for (const key of ctx.args.keys) {
      const contact = key.slice(key.indexOf("|") + 1);
      const e = byContact.get(contact);
      byKey[key] = [];
      if (!sequence || sequence.data.status !== "active" || !e || e.data.state !== "active") continue;
      const out = byKey[key];
      const expect = [{ collection: "enrollments", key: e.key, version: e.version }];
      let stepIndex = Number(e.data.stepIndex ?? 0);
      let lastDay = e.data.lastDay ?? null;
      const startDay = e.data.startDay ?? firstDay(ctx.now, s);
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
      out.push({
        op: "patch",
        collection: "enrollments",
        key: e.key,
        expect,
        data: { stepIndex, startDay, ...lastDay ? { lastDay } : {}, ...due ? {} : { nextAt: next.nextAt } },
        ...due ? { unset: ["nextAt"] } : {}
      });
      if (due && MANUAL_STEPS.includes(step.kind)) {
        out.push({ op: "put", collection: "tasks", data: {
          sequence: sequence.key,
          contact,
          stepIndex,
          kind: step.kind,
          dueDay: next.day,
          ...e.owner ? { rep: e.owner } : {},
          ...step.note ? { note: step.note } : {},
          ...step.priority ? { priority: step.priority } : {},
          ...e.data.contactName ? { contactName: e.data.contactName } : {},
          ...e.data.title ? { title: e.data.title } : {},
          ...e.data.email ? { email: e.data.email } : {},
          ...e.data.linkedinUrl ? { linkedinUrl: e.data.linkedinUrl } : {}
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
    const sequence = reads.sequence;
    if (!sequence || sequence.data.status === "archived") throw new Error("That sequence is archived or gone.");
    const snap = reads.snapshot[0];
    const audience = reads.audiences.find((a) => a.id === ctx.args.audience);
    const data = { sequence: sequence.key, snapshot: snap.id, audience: String(ctx.args.audience), audienceName: audience?.name ?? "Audience", count: snap.count, pages: snap.pages };
    return { intents: [{ op: "op", name: "enrollRuns.create", data }], value: { key: snap.id, count: snap.count } };
  },
  /** One page of the audience copied into the run, then checked; page 0 reads the other pages too. */
  snapPage(ctx, reads) {
    const key = oneKey(ctx);
    const run = reads.run;
    if (!run) return { byKey: { [key]: [] } };
    const page = String(ctx.args.page);
    const people = reads.people.map((p) => ({ id: p.id, ...p.name ? { name: p.name } : {}, ...p.title ? { title: p.title } : {}, ...p.email ? { email: p.email } : {}, ...p.linkedinUrl ? { linkedinUrl: p.linkedinUrl } : {} }));
    const intents = [
      { op: "put", collection: "enrollPages", data: { run: run.key, page, ids: people.map((p) => p.id), people, nPeople: people.length } },
      { op: "dirty", job: "check", key: `${run.key}|${page}` }
    ];
    if (page === "0") for (let n = 1; n < Number(run.data.pages); n++) intents.push({ op: "dirty", job: "snap", key: `${run.key}|${n}` });
    return { byKey: { [key]: intents } };
  },
  /** Who on one page to skip and why (engine `skipReasons`): suppression and LinkedIn cadences wait for Canon's reads. */
  checkPage(ctx, reads) {
    const key = oneKey(ctx);
    const [sheet] = reads.sheet;
    const sequence = reads.sequence;
    if (!sheet || !sequence) return { byKey: { [key]: [] } };
    const people = sheet.data.people ?? [];
    const existing = reads.existing;
    const { enroll, skipped } = skipReasons(people.map((p) => ({ id: p.id, email: p.email, linkedinUrl: p.linkedinUrl, fields: fieldsOf(p) })), {
      suppressed: /* @__PURE__ */ new Map(),
      activeElsewhere: new Set(existing.filter((e) => ACTIVE.includes(String(e.data.state))).map((e) => String(e.data.contact))),
      enrolledBefore: new Set(existing.filter((e) => e.data.sequence === sequence.key).map((e) => String(e.data.contact))),
      addPolicy: sequence.data.addPolicy ?? "once",
      lastContactedAt: /* @__PURE__ */ new Map(),
      contactLatencyDays: 0,
      steps: stepsOf(reads.steps),
      now: ctx.now,
      checkable: CHECKABLE
    });
    const names = new Map(people.map((p) => [p.id, p.name]));
    const run = reads.run;
    const intents = [{
      op: "patch",
      collection: "enrollPages",
      key: sheet.key,
      expect: [{ collection: "enrollPages", key: sheet.key, version: sheet.version }],
      data: { enroll, skipped: skipped.map((s) => ({ ...s, ...names.get(s.id) ? { name: names.get(s.id) } : {} })), nEnroll: enroll.length, nSkipped: skipped.length }
    }];
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
    const run = reads.run;
    const [sheet] = reads.sheet;
    const sequence = reads.sequence;
    const rest = run && String(ctx.args.page) === "0" ? Array.from({ length: Math.max(0, Number(run.data.pages) - 1) }, (_, i) => ({ op: "dirty", job: "enroll", key: `${run.key}|${i + 1}` })) : [];
    if (!run || !sequence || run.data.status !== "enrolling") return { byKey: { [key]: [] } };
    if (!sheet || !Array.isArray(sheet.data.enroll)) return { byKey: { [key]: rest } };
    const taken = new Set(reads.existing.filter((e) => ACTIVE.includes(String(e.data.state)) || e.data.sequence === sequence.key).map((e) => String(e.data.contact)));
    const people = new Map((sheet.data.people ?? []).map((p) => [p.id, p]));
    const ids = (sheet.data.enroll ?? []).filter((id) => !taken.has(id));
    const intents = ids.map((id) => {
      const p = people.get(id);
      return { op: "put", collection: "enrollments", data: {
        sequence: sequence.key,
        contact: id,
        stepIndex: 0,
        run: run.key,
        // Into a running sequence: it starts now. Otherwise Launch starts it.
        ...sequence.data.status === "active" ? { nextAt: ctx.now } : {},
        ...sequence.owner ? { rep: sequence.owner } : {},
        ...p?.name ? { contactName: p.name } : {},
        ...p?.title ? { title: p.title } : {},
        ...p?.email ? { email: p.email } : {},
        ...p?.linkedinUrl ? { linkedinUrl: p.linkedinUrl } : {}
      } };
    });
    intents.push({ op: "patch", collection: "enrollPages", key: sheet.key, data: { nEnrolled: ids.length + Number(sheet.data.nEnrolled ?? 0) } }, ...rest);
    return { byKey: { [key]: intents } };
  },
  /** The steps in the order dragged: each moved step's position, 1 up, checked against the order the page read. */
  reorderSteps(ctx, reads) {
    const steps = reads.steps;
    const keys = ctx.args.keys ?? [];
    const byKey = new Map(steps.map((s) => [s.key, s]));
    if (keys.length !== steps.length || keys.some((k) => !byKey.has(k))) throw new Error("The steps changed since the page read them. Reload and drag again.");
    const intents = keys.flatMap((key, i) => {
      const step = byKey.get(key);
      return step.data.position === i + 1 ? [] : [{ op: "patch", collection: "steps", key, data: { position: i + 1 }, expect: [{ collection: "steps", key, version: step.version }] }];
    });
    return { intents, value: { moved: intents.length } };
  },
  /** The day each step would go out for someone enrolled now, with no outcome stopping them and every task done on its day. */
  timeline(ctx, reads) {
    const sequence = reads.sequence;
    const steps = (reads.steps ?? []).map((d) => d.data).sort((a, b) => a.position - b.position);
    if (!sequence) return { value: { rows: [] } };
    const s = scheduleOf(reads.schedule);
    const interval = sequence.data.intervalType === "calendar_days" ? "calendar_days" : "schedule_days";
    const rows = [];
    let lastDay = null;
    for (let i = 0; i < steps.length; i++) {
      const next = plan({ stepIndex: i, lastDay }, steps, s, ctx.now, interval);
      if (next.done) break;
      rows.push({ n: i + 1, kind: KIND_LABEL[steps[i].kind], day: next.day, who: MANUAL_STEPS.includes(steps[i].kind) ? "The rep, from their task inbox" : "Canon, from the sender" });
      lastDay = next.day;
    }
    return { value: { rows } };
  }
};
export {
  calls
};
