import assert from "node:assert/strict";
import { test } from "node:test";
import { inspectionHref, inspectionTarget, recordHref } from "../src/components/records/record-target.ts";

test("inspection changes record identity while retaining its originating view", () => {
  const account = inspectionHref("/dashboard/contacts", "q=ada&sort=name", { object: "account", id: "acc_1/opaque" });
  assert.equal(account, "/dashboard/contacts?q=ada&sort=name&peekObject=account&peekId=acc_1%2Fopaque");
  const person = inspectionHref("/dashboard/contacts", account.split("?")[1], { object: "contact", id: "con_1" });
  assert.deepEqual(inspectionTarget(new URLSearchParams(person.split("?")[1])), { object: "contact", id: "con_1" });
  assert.equal(inspectionHref("/dashboard/contacts", person.split("?")[1], null), "/dashboard/contacts?q=ada&sort=name");
  assert.equal(recordHref("account", "acc_1/opaque"), "/dashboard/accounts/acc_1%2Fopaque");
  assert.equal(recordHref("contact", "con_1"), "/dashboard/records/contact/con_1");
});

test("inspection hrefs keep their query where URLSearchParams has no size (Safari before 17)", (t) => {
  const size = Object.getOwnPropertyDescriptor(URLSearchParams.prototype, "size");
  Object.defineProperty(URLSearchParams.prototype, "size", { configurable: true, get: () => undefined });
  t.after(() => { if (size) Object.defineProperty(URLSearchParams.prototype, "size", size); else Reflect.deleteProperty(URLSearchParams.prototype, "size"); });
  assert.equal(inspectionHref("/dashboard/accounts", "q=ada", { object: "account", id: "acc_1" }), "/dashboard/accounts?q=ada&peekObject=account&peekId=acc_1");
  assert.equal(inspectionHref("/dashboard/accounts", "q=ada&peekObject=account&peekId=acc_1", null), "/dashboard/accounts?q=ada");
  assert.equal(inspectionHref("/dashboard/accounts", "peekObject=account&peekId=acc_1", null), "/dashboard/accounts");
});

test("shared legacy inspections open on their own list and normalize without changing filters", () => {
  const params = new URLSearchParams("status=won&record=stream_1");
  assert.deepEqual(inspectionTarget(params, "/dashboard/deals"), { object: "deal", id: "stream_1" });
  assert.deepEqual(inspectionTarget(params, "/dashboard/records/deal"), { object: "deal", id: "stream_1" });
  assert.equal(inspectionTarget(params, "/dashboard/tasks"), null);
  assert.equal(inspectionTarget(new URLSearchParams("peekObject=contact")), null);
  assert.equal(inspectionHref("/dashboard/deals", params.toString(), { object: "account", id: "acc_1" }), "/dashboard/deals?status=won&peekObject=account&peekId=acc_1");
  assert.equal(inspectionHref("/dashboard/deals", params.toString(), null), "/dashboard/deals?status=won");
});
