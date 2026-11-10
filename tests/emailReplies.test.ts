import assert from "node:assert/strict";
import test from "node:test";
import { readReceived } from "../convex/lib/email/replies.ts";
import { emailReplyOf } from "../convex/lib/linkedin/inbound.ts";

// Tue 2026-11-03 09:00 UTC, the day the Northwind golden's Monday cohort replies (docs/module-plans/sequences.md §12).
const NOW = Date.UTC(2026, 10, 3, 9);
const read = (from: string, subject: string, body: string) => readReceived({ from, subject, body, inbox: "avery@northwind-mail.test", now: NOW });

test("a received email reads as a bounce, an auto-reply or a reply with its class", () => {
  const cases: Array<[string, ReturnType<typeof read>, unknown]> = [
    ["hard bounce for the reported recipient", read("mailer-daemon@googlemail.com", "Delivery Status Notification (Failure)", "Final-Recipient: rfc822; c07@northwind.test\nStatus: 5.1.1"), { kind: "bounce", bounce: { hard: true, status: "5.1.1", recipient: "c07@northwind.test" } }],
    ["a delay is not hard", read("postmaster@x.test", "Delivery delayed", "Status: 4.4.7 to c08@northwind.test"), { kind: "bounce", bounce: { hard: false, status: "4.4.7", recipient: "c08@northwind.test" } }],
    ["OOO with its return date, quotes cut", read("c09@northwind.test", "Automatic reply: Q4 planning", "I'm out of the office and back on Monday, November 9.\n\nOn Mon, Nov 2 Avery wrote:\n> hi"), { kind: "auto_reply", auto: { returnOn: "2026-11-09" }, body: "I'm out of the office and back on Monday, November 9." }],
    ["OOO with no date holds 7 days", read("c10@northwind.test", "Out of Office", "I am currently away with limited access to email."), { kind: "auto_reply", auto: { returnOn: "2026-11-10" }, body: "I am currently away with limited access to email." }],
    ["interested", read("c04@northwind.test", "Re: Q4 planning", "Sounds interesting, let's find a time Thursday.\n> earlier"), { kind: "reply", body: "Sounds interesting, let's find a time Thursday.", class: "interested", askModel: false }],
    ["an opt-out beats a polite opener", read("c12@northwind.test", "Re: Q4", "Sounds good but please remove me from your list."), { kind: "reply", body: "Sounds good but please remove me from your list.", class: "unsubscribe", askModel: false }],
    ["not now", read("c13@northwind.test", "Re: Q4", "Not a priority this year, circle back in Q2."), { kind: "reply", body: "Not a priority this year, circle back in Q2.", class: "not_now", askModel: false }],
    ["not interested", read("c14@northwind.test", "Re: Q4", "No thanks, we're all set."), { kind: "reply", body: "No thanks, we're all set.", class: "not_interested", askModel: false }],
    ["unplaced words go to the model", read("c16@northwind.test", "Re: Q4", "Who else on your team works with fintech CFOs?"), { kind: "reply", body: "Who else on your team works with fintech CFOs?", class: null, askModel: true }],
    ["a short reply never does", read("c17@northwind.test", "Re: Q4", "Thanks!"), { kind: "reply", body: "Thanks!", class: null, askModel: false }],
  ];
  for (const [name, got, want] of cases) assert.deepEqual(got, want, name);
});

test("the webhook's mail carries the plain body and the Message-ID it answers", () => {
  const mail = { event: "mail_received", account_id: "acc1", message_id: "<m2@x>", from_attendee: { identifier: "C04@Northwind.test" }, subject: "Re: Q4",
    body: "<p>Let&#39;s talk</p>", in_reply_to: { message_id: "<m1@x>", id: "e1" }, folders: ["INBOX"] };
  assert.deepEqual(emailReplyOf(mail), { accountId: "acc1", from: "c04@northwind.test", subject: "Re: Q4", body: "Let's talk\n", inReplyTo: "m1@x", messageId: "m2@x", at: null });
});
