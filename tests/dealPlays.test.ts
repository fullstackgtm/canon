import assert from "node:assert/strict";
import test from "node:test";
import { orgTree, summaryOf, threadOf as threadAt, touchDoing, touchesFromActivities, touchesFromLog, type StepLike, type Touch } from "../convex/lib/plays/model.ts";
import { screenFindings } from "../convex/lib/plays/research.ts";
import { cleanDraft, cleanReview, emailParagraphs, LINKEDIN_MAX, type DraftInput } from "../convex/lib/plays/drafts.ts";
import { defaultPlays } from "../recipes/index.ts";

const plays = defaultPlays("fsgtm-enterprise-deal")!;
const threadOf = (touches: Touch[], at: number) => threadAt(touches, at, plays.quietDays);

const DAY = 86_400_000;
const now = Date.parse("2026-10-11T12:00:00Z");
const out = (contactId: string, daysAgo: number, channel: Touch["channel"] = "linkedin"): Touch => ({ contactId, channel, direction: "out", at: now - daysAgo * DAY, summary: "" });
const inn = (contactId: string, daysAgo: number): Touch => ({ contactId, channel: "linkedin", direction: "in", at: now - daysAgo * DAY, summary: "" });

test("a thread reads untouched, waiting, replied, engaged or quiet from its touches", () => {
  assert.equal(threadOf([], now).state, "untouched");
  assert.equal(threadOf([out("a", 3)], now).state, "waiting");
  assert.equal(threadOf([out("a", 5), inn("a", 2)], now).state, "replied");
  assert.equal(threadOf([inn("a", 5), out("a", 2)], now).state, "engaged");
  assert.equal(threadOf([out("a", 20)], now).state, "quiet");
  // LinkedIn events from the log: a reply is inbound, an invite outbound.
  const log = touchesFromLog("a", [
    { observedAt: now - 4 * DAY, body: { type: "linkedin", event: { kind: "invite_sent" } } },
    { observedAt: now - 1 * DAY, body: { type: "linkedin", event: { kind: "reply_received" } } },
    { observedAt: now, body: { type: "signal_seen" } },
  ]);
  assert.deepEqual(log.map((t) => t.direction), ["out", "in"]);
  // A meeting booked for tomorrow is not a touch yet.
  assert.deepEqual(touchesFromActivities([{ kind: "meeting", at: now + DAY, title: "Demo", targets: [{ object: "contact", id: "a" }] }], new Set(["a"]), now), []);
});

test("a planned step is done by the first outbound touch to its person on its channel after it was made", () => {
  const step: StepLike = { id: "s", title: "Invite the CFO", channel: "linkedin", role: "executive", state: "planned", createdAt: now - 5 * DAY };
  assert.equal(touchDoing(step, "cfo", [out("cfo", 6), inn("cfo", 1), out("cfo", 1, "email")]), null);
  assert.equal(touchDoing(step, "cfo", [out("cfo", 2), out("cfo", 1)])?.at, now - 2 * DAY);
});

test("room engagement is inbound on Other for its pinned deal and never completes an outreach step", () => {
  const log = [
    { observedAt: now, body: { type: "room", event: "opened", dealStreamId: "d1" } },
    { observedAt: now + 1, body: { type: "room", event: "acted", dealStreamId: "d1" } },
    { observedAt: now, body: { type: "room", event: "opened", dealStreamId: "d2" } },
    { observedAt: now, body: { type: "room", event: "opened" } },
    { observedAt: now, body: { type: "erased", dealStreamId: "d1" } },
  ];
  const touches = touchesFromLog("buyer", log, "d1");
  assert.deepEqual(touches, [
    { contactId: "buyer", channel: "other", direction: "in", at: now, summary: "Viewed the customer room" },
    { contactId: "buyer", channel: "other", direction: "in", at: now + 1, summary: "Updated the customer room" },
  ]);
  assert.deepEqual(touchesFromLog(null, log, "d1").map((t) => t.contactId), [null, null]);
  assert.deepEqual(touchesFromLog("buyer", log), []);
  for (const channel of ["email", "linkedin", "call", "meeting"] as const) {
    assert.equal(touchDoing({ id: "s", title: "Reach out", channel, state: "planned", createdAt: now - 1 }, "buyer", touches), null);
  }
  assert.deepEqual(threadOf(touchesFromLog("buyer", log, "missing"), now), threadOf([], now));
});

test("the keeper puts a reply owed above coverage gaps and proposes the follow-up", () => {
  const thread = (touches: Touch[]) => threadOf(touches, now);
  const report = plays.keeper({
    now, hasCompany: true, windowClosesOn: "2026-11-15", windowLabel: "ICM RFP", researchedAt: null, hasBrief: true,
    members: [
      { contactId: "cro", name: "Dana", role: "executive", thread: thread([out("cro", 3)]) },
      { contactId: "ops", name: "Lee", role: "n1", thread: thread([out("ops", 6), inn("ops", 1)]) },
    ],
    steps: [{ id: "s1", title: "Pre-demo", channel: "meeting", state: "planned", dueOn: "2026-10-01", createdAt: now - 20 * DAY, doneByTouch: false }],
  });
  assert.equal(report.health, "at_risk");
  assert.deepEqual(report.flags.filter((f) => f.severity === "high").map((f) => f.key), ["role:champion", "replied:ops"]);
  assert.equal(report.flags.find((f) => f.key === "replied:ops")?.propose?.contactId, "ops");
  assert.ok(report.flags.some((f) => f.key === "overdue:s1"));
  assert.equal(report.windowDays, 36);
});

test("research keeps only facts whose quote is on a page read, and turns unknown named people into cited gaps", () => {
  const pages = [{ url: "https://news.example/northstar", text: "Northstar named Jane Smith Chief Revenue Officer in September 2026, the company said.", links: [] }];
  const raw = {
    whyNow: "New CRO", alphaHypothesis: "a", alphaPitch: "b",
    items: [
      { kind: "timeline", text: "New CRO", quote: "named Jane Smith Chief Revenue Officer", sourceUrl: "https://news.example/northstar", occurredOn: "2026-09-01" },
      { kind: "signal", text: "Hiring comp analysts", quote: "hiring five compensation analysts", sourceUrl: "https://news.example/northstar", occurredOn: "" },
      { kind: "risk", text: "Incumbent renewal", quote: "", sourceUrl: "", occurredOn: "" },
    ],
    people: [
      { name: "Jane Smith", title: "CRO", suggestedRole: "executive", persona: "", angle: "Lead with ramp", confidence: "medium", quote: "named Jane Smith Chief Revenue Officer", sourceUrl: "https://news.example/northstar" },
      { name: "Ravi Rao", title: "VP Sales Ops", suggestedRole: "n1", persona: "p", angle: "x", confidence: "high", quote: "", sourceUrl: "" },
      { name: "Invented Smith", title: "CFO", suggestedRole: "executive", persona: "", angle: "", confidence: "low", quote: "named Jane Smith Chief Revenue Officer", sourceUrl: "https://news.example/northstar" },
      { name: "Comp Leader (open role)", title: "GTM Compensation Leader", suggestedRole: "champion", persona: "", angle: "", confidence: "low", quote: "named Jane Smith Chief Revenue Officer", sourceUrl: "https://news.example/northstar" },
      { name: "Made Up", title: "CFO", suggestedRole: "", persona: "", angle: "", confidence: "low", quote: "not on any page at all", sourceUrl: "" },
    ],
    steps: [{ title: "Invite Ravi", channel: "linkedin", personName: "Ravi Rao", role: "", dueInDays: 2 }],
  };
  const s = screenFindings(raw, pages, [{ id: "con_ravi", name: "Ravi Rao" }], "2026-10-11");
  assert.deepEqual(s.items.map((i) => [i.kind, i.evidence]), [["timeline", "verified"], ["risk", "none"], ["gap", "verified"]]);
  assert.equal(s.dropped, 4);
  assert.deepEqual(s.people.map((p) => p.contactId), ["con_ravi"]);
  assert.deepEqual(s.steps, [{ title: "Invite Ravi", channel: "linkedin", contactId: "con_ravi", dueOn: "2026-10-13" }]);
});

test("a draft keeps a subject only for email and fits LinkedIn's note limit", () => {
  assert.equal(cleanDraft("email", { subject: "", body: "  " }), null);
  // An email's single line breaks become paragraphs; a body already in paragraphs, and a LinkedIn note, keep theirs.
  assert.equal(cleanDraft("email", { subject: "s", body: "Hi Tim,\nFirst.\nRyan" })!.body, "Hi Tim,\n\nFirst.\n\nRyan");
  assert.equal(emailParagraphs("Hi Tim,\n\nFirst line\nsecond.\n\nRyan"), "Hi Tim,\n\nFirst line\nsecond.\n\nRyan");
  assert.equal(cleanDraft("linkedin", { subject: "", body: "Hi\nTim" })!.body, "Hi\nTim");
  assert.deepEqual(cleanDraft("email", { subject: " ICM migration ", body: "Hi Tim" }), { subject: "ICM migration", body: "Hi Tim" });
  const note = cleanDraft("linkedin", { subject: "ignored", body: "x".repeat(400) })!;
  assert.equal(note.subject, undefined);
  assert.equal(note.body.length, LINKEDIN_MAX);
});

test("draft checks pass a short email and name what fails in a long one", () => {
  const good = "Hi Priya,\n\nMarcus wants pages halved next year. Your pilot cut alerts 38%.\nWould 20 minutes with him next week help?\n\nRyan";
  assert.deepEqual(plays.drafts.check("email", "For Marcus", good).filter((c) => !c.ok), []);
  const bad = plays.drafts.check("email", "", `Hi Priya,\n\n${"We are better than Relay. ".repeat(5)}What keeps you up at night? Can we talk?\n\nRyan`);
  assert.deepEqual(bad.filter((c) => !c.ok).map((c) => c.key), ["length", "subject", "ask", "comparative", "wand"]);
  assert.equal(plays.drafts.check("call", null, "Open: hi.\n- Is it measured?\nClose: book the next call.").every((c) => c.ok), true);
  assert.equal(plays.drafts.check("linkedin", null, "Our platform automates commissions. Want a demo?").find((c) => c.key === "pitch")?.ok, false, "a first touch shares a view, it doesn't pitch");
  const stiff = plays.drafts.check("email", "plan sprawl", "Hi Amanda,\n\nMy view is that the hard part isn't the math; it's the plans.\nHow are you measuring or managing that work today, and have you tried a hire, a tool, or neither?\n\nRyan");
  assert.deepEqual(stiff.filter((c) => !c.ok).map((c) => c.key), ["plain", "easy-ask"], "announced opinions, semicolons and a long ask read as machine-written");
});

test("a deal uses one ICP's point of view: the default it's in, else the oldest", () => {
  const icps = [
    { id: "a", name: "Old", pointOfView: "Routing, not volume.", isDefault: false, createdAt: 1 },
    { id: "b", name: "Default", pointOfView: null, isDefault: true, createdAt: 2 },
  ];
  assert.deepEqual(plays.pointOfView(["a", "b"], icps), { icpId: "b", icpName: "Default", text: null, offer: null });
  assert.deepEqual(plays.pointOfView(["a"], icps), { icpId: "a", icpName: "Old", text: "Routing, not volume.", offer: null });
  assert.equal(plays.pointOfView([], icps), null);
});

test("the draft prompt builds on the point of view, or forbids inventing one; a review keeps it only when there was one", () => {
  const input: DraftInput = {
    channel: "email", stepTitle: "Arm Priya", company: "Atlas", context: null, whyNow: null, alphaPitch: null,
    person: { name: "Priya", title: "Director", role: "Champion", persona: null, angle: null },
    pointOfView: { icp: "Platform", text: "Most alert noise comes from routing." }, facts: [], history: [], sender: "Ryan",
  };
  assert.match(plays.drafts.prompt(input), /Most alert noise comes from routing\./);
  assert.match(plays.drafts.prompt({ ...input, pointOfView: null }), /Don't invent a belief/);
  assert.doesNotMatch(plays.drafts.prompt({ ...input, channel: "call" }), /Never ask for a call/, "a call script still books the next call");
  assert.deepEqual(cleanReview({ relevant: true, pointOfView: false, surprising: false, wouldReply: true, note: "" }, false), { relevant: true, wouldReply: true }, "no point of view: judged on neither");
  assert.equal(cleanReview({ relevant: "yes" }, true), null);
});

test("prep names what's missing, why the deal is slow, and the questions those gaps raise", () => {
  const quiet = { state: "quiet" as const, lastOut: now - 11 * DAY, lastIn: now - 12 * DAY, lastChannel: "email" as const, touches: 3 };
  const never = { state: "untouched" as const, lastOut: null, lastIn: null, lastChannel: null, touches: 0 };
  const prep = plays.prep({
    now, company: "Atlas", dealName: "Platform Expansion", windowLabel: "Budget lock", windowDays: 19, hasWhyNow: true, steps: [],
    members: [{ name: "Priya Raman", role: "champion", thread: quiet }, { name: "Marcus Webb", role: "executive", thread: never }],
  });
  assert.equal(prep.stall?.kind, "selling_up");
  assert.equal(prep.verdict, "Priya Raman is carrying this alone, and Marcus Webb hasn't heard from us. Budget lock closes in 19 days.");
  assert.deepEqual(prep.checks.filter((c) => !c.ok).map((c) => c.key), ["exec", "second", "next", "signer"]);
  assert.equal(prep.questions.length, 3);
  assert.match(prep.questions[0], /Marcus Webb said publicly/);
  const booked = plays.prep({
    now, company: "Atlas", dealName: "X", windowLabel: null, windowDays: null, hasWhyNow: false,
    members: [{ name: "Marcus Webb", role: "executive", thread: quiet }], steps: [{ channel: "call", dueOn: "2026-10-14", state: "planned", doneByTouch: false }],
  });
  assert.equal(booked.stall?.kind, "unframed", "a booked call isn't polite interest; no why-now or window is");
});

test("research answers a question only with a quote found in a page it read", () => {
  const pages = [{ url: "https://atlas.example/news", text: "Marcus Webb: next year's goal is to halve the pages per engineer.", links: [] }];
  const raw = { answers: [
    { question: "What has Marcus said?", answer: "Halve pages per engineer.", quote: "halve the pages per engineer", sourceUrl: "https://atlas.example/news" },
    { question: "Who signs?", answer: "The CFO.", quote: "the CFO signs everything", sourceUrl: "https://atlas.example/news" },
  ] };
  const s = screenFindings(raw, pages, [], "2026-10-11", ["What has Marcus said?", "Who signs?", "Is it measured?"]);
  assert.deepEqual(s.answers, [
    { question: "What has Marcus said?", answer: "Halve pages per engineer.", quote: "halve the pages per engineer", sourceUrl: "https://atlas.example/news" },
    { question: "Who signs?" },
    { question: "Is it measured?" },
  ]);
});

test("a deal finds its way in until someone replies, then builds the case, and closes from 60%", () => {
  const silent = { thread: { state: "waiting" as const, lastOut: now, lastIn: null, lastChannel: null, touches: 1 } };
  const replied = { thread: { state: "replied" as const, lastOut: now, lastIn: now, lastChannel: null, touches: 2 } };
  assert.equal(plays.stage({ probability: 0.4, members: [silent] }), "in", "probability doesn't count until someone answers");
  assert.equal(plays.stage({ probability: 0.2, members: [silent, replied] }), "case");
  assert.equal(plays.stage({ probability: 0.7, members: [replied] }), "close");
  const row = (key: string, extra: object) => ({ key, contactId: key, itemId: null, name: key, title: null, source: "company" as const, role: null, buyer: false, researched: false, why: null, reached: null, center: null, capability: null, ...extra });
  const ranked = plays.fanOut([row("exec", { role: "executive", buyer: true }), row("buyer", { buyer: true }), row("other", {}), row("reached", { buyer: true, reached: "Waiting" })]);
  assert.deepEqual(ranked.filter((p) => p.suggested).map((p) => p.key), ["buyer", "other"], "the executive waits, and nobody already reached is suggested");
});

test("inbound webhooks read someone else's LinkedIn message and received mail, never our own", async () => {
  const { linkedinReplyOf, emailReplyOf } = await import("../convex/lib/linkedin/inbound.ts");
  const msg = { event: "message_received", account_type: "LINKEDIN", account_id: "acc", chat_id: "c1", message_id: "m1", timestamp: "2026-10-11T10:00:00Z", account_info: { user_id: "me" }, sender: { attendee_provider_id: "them" } };
  assert.equal(linkedinReplyOf(msg)?.senderProviderId, "them");
  assert.equal(linkedinReplyOf({ ...msg, sender: { attendee_provider_id: "me" } }), null);
  const mail = { event: "mail_received", account_id: "acc", message_id: "<x@y>", subject: "Re: hi", from_attendee: { identifier: "Tim@Northstar.example" }, folders: ["INBOX"] };
  assert.equal(emailReplyOf(mail)?.from, "tim@northstar.example");
  assert.equal(emailReplyOf({ ...mail, folders: ["SENT"] }), null);
});

test("the org chart nests reports under their manager, and a loop or an off-deal manager makes a root", () => {
  const p = (contactId: string, reportsTo: string | null) => ({ contactId, reportsTo });
  const tree = orgTree([p("cfo", null), p("ctl", "cfo"), p("ops", "ctl"), p("x", "y"), p("y", "x"), p("z", "gone")]);
  assert.deepEqual(tree.map((n) => n.person.contactId), ["cfo", "x", "y", "z"]);
  assert.equal(tree[0].reports[0].reports[0].person.contactId, "ops");
  const s = summaryOf([{ role: "executive", thread: threadOf([out("a", 1), inn("a", 0)], now) }, { role: "user", thread: threadOf([], now) }],
    [{ state: "planned", dueOn: "2026-10-20", doneByTouch: false }, { state: "planned", dueOn: "2026-10-12", doneByTouch: true }], plays.coreRoles);
  assert.deepEqual(s, { people: 2, engaged: 1, repliesOwed: 1, coreFilled: 1, openSteps: 1, nextDue: "2026-10-20" });
});

test("a play's LinkedIn cadence is valid and sends each person's own draft", async () => {
  const { validateSteps, render } = await import("../convex/lib/linkedin/cadence.ts");
  const steps = [{ kind: "invite" as const }, { kind: "message" as const, body: "{{custom.play_message}}", delayDays: 0 }];
  assert.equal(validateSteps(steps, "premium"), null);
  assert.deepEqual(render("{{custom.play_message}}", { "custom.play_message": "Michael, worth comparing notes?" }), { text: "Michael, worth comparing notes?" });
});
