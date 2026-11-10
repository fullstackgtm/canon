import assert from "node:assert/strict";
import { test } from "node:test";
import { policyFromDefinitions } from "../engine/src/sync/salesforceSync/policy.ts";

test("standard objects sync only curated 1:1 fields, ignoring import-only mappedTo", () => {
  const policy = policyFromDefinitions(
    [
      { apiName: "Account", isCustom: false, syncEnabled: true },
      { apiName: "Widget__c", isCustom: true, syncEnabled: true },
    ],
    [
      { object: "Account", apiName: "Name", updateable: true, syncAuthority: "newest", mappedTo: "name" },
      { object: "Account", apiName: "Website", updateable: true, syncAuthority: "newest", mappedTo: "domain" },
      { object: "Account", apiName: "OwnerId", updateable: true, syncAuthority: "salesforce", mappedTo: "ownerId" },
      { object: "Account", apiName: "Industry", updateable: true, syncAuthority: "fsgtm" },
      { object: "Widget__c", apiName: "Size__c", updateable: true, syncAuthority: "newest" },
    ],
  );
  const account = policy.objects.find((o) => o.sf === "Account")!;
  assert.deepEqual(account.fields.map((f) => [f.sf, f.local, f.authority]), [["Name", "name", "newest"], ["Industry", "industry", "fsgtm"]]);
  const widget = policy.objects.find((o) => o.sf === "Widget__c")!;
  assert.deepEqual(widget.fields.map((f) => f.local), ["Size__c"]);
});
