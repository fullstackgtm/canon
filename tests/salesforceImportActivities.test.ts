import assert from "node:assert/strict";
import test from "node:test";
import { mapDocument, mapTask } from "../engine/src/sync/salesforceImport/activities.ts";

const owners = new Map([["005Sm0000000001IAA", { sfUserId: "005Sm0000000001IAA", name: "Avery", memberId: "user_avery" }]]);

test("a Task logged as a call becomes a call about its person and deal; a plain one a task", () => {
  const call = {
    Id: "00TSm0000000001", WhoId: "003Sm0000000001", WhatId: "006Sm0000000001", Subject: "Call", ActivityDate: "2026-03-02", Status: "Completed", Priority: "Normal",
    TaskSubtype: "Call", CallType: "Outbound", CallDurationInSeconds: "320", CallDisposition: "Asked to call back", Description: "Pricing.", OwnerId: "005Sm0000000001IAA",
    CreatedDate: "2026-03-02T10:00:00.000+0000", SystemModstamp: "",
  };
  assert.deepEqual(mapTask(call, owners), {
    ok: {
      sfId: "00TSm0000000001MAA", object: "call", ownerSfId: "005Sm0000000001IAA", targetSfIds: ["003Sm0000000001IAA", "006Sm0000000001IAA"], createdAt: Date.parse("2026-03-02T10:00:00Z"),
      values: { subject: "Call", direction: "outbound", outcome: null, callAt: Date.parse("2026-03-02"), durationSeconds: 320, notes: "Pricing.\n\nCall result: Asked to call back", ownerId: "user_avery" },
    },
  });
  assert.deepEqual(mapTask({ ...call, TaskSubtype: "Task", Status: "Waiting on someone else", Subject: "", OwnerId: "005Sm0000000009" }, owners).ok?.values, {
    subject: "Task", status: "waiting", priority: "normal", dueDate: "2026-03-02", description: "Pricing.", ownerId: null,
  });
});

test("a file becomes a note linking to it in Salesforce, about the records it is shared to and not its users", () => {
  const row = { Id: "069Sm0000000001", Title: "Order form", FileType: "PDF", FileExtension: "pdf", ContentSize: "2097152", OwnerId: "", CreatedDate: "", SystemModstamp: "" };
  assert.deepEqual(mapDocument(row, owners, ["005Sm0000000001IAA", "006Sm0000000001IAA"], "https://acme.my.salesforce.com/"), {
    ok: {
      sfId: "069Sm0000000001IAA", object: "note", targetSfIds: ["006Sm0000000001IAA"],
      values: { body: "File in Salesforce: Order form.pdf (2.0 MB)\nhttps://acme.my.salesforce.com/lightning/r/ContentDocument/069Sm0000000001IAA/view", ownerId: null },
    },
  });
  assert.deepEqual(mapDocument(row, owners, ["005Sm0000000001IAA"], "https://x"), { reject: "Not linked to any record (only to users)" });
});
