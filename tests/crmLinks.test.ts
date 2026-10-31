import assert from "node:assert/strict";
import { test } from "node:test";
import { crmContactLinks, linkCrmContacts } from "../convex/lib/crmLinks.ts";
import { createMemoryRecordStore, recordClient } from "../convex/lib/recordClient.ts";

test("a CRM sync links each emailed contact to its company in the register, making sure of the company first", async () => {
  const links = crmContactLinks(
    [{ crmId: "a1", domain: "acme.example", name: "Acme" }, { crmId: "a2", name: "No Domain Inc" }, { crmId: "a3", domain: "idle.example" }],
    [
      { email: "ann@gmail.com", firstName: "Ann", lastName: "Lee", accountCrmId: "a1" },
      { email: "bo@nodomain.example", accountCrmId: "a2" },
      { firstName: "No", lastName: "Email", accountCrmId: "a1" },
      { email: "cy@acme.example" },
    ],
  );
  assert.deepEqual(links, { accounts: [{ domain: "acme.example", name: "Acme" }], links: [{ accountDomain: "acme.example", email: "ann@gmail.com", fullName: "Ann Lee" }] });

  const client = recordClient({ store: createMemoryRecordStore(), env: {} });
  assert.equal(await linkCrmContacts(client, "ws", "hubspot", "run1", links), 1);
  const [contact] = (await client.listContacts("ws", { limit: 10 })).rows;
  assert.equal(contact.email, "ann@gmail.com");
  assert.equal(contact.accountId, (await client.list("ws", { limit: 10 })).rows[0].id);
});
