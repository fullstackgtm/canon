import assert from "node:assert/strict";
import { test } from "node:test";
import { crmHeadline } from "../convex/lib/crmFingerprints.ts";
import { researchTeamShape } from "../convex/lib/teamShape.ts";

const HOSTS: Record<string, string> = {
  hsforms: '<script src="https://js.hsforms.net/forms/v2.js"></script>',
  hsscripts: '<script src="https://js.hs-scripts.com/1.js"></script>',
  salesforce:
    '<form action="https://webto.salesforce.com/servlet/servlet.WebToLead">',
  pardot: '<script src="https://pi.pardot.com/pd.js"></script>',
  marketo: "<script>MktoForms2.loadForm()</script>",
};

test("the CRM headline is supported by every fingerprint cited under it", async () => {
  const golden: Array<[string[], string | null, boolean, string[]]> = [
    [[], null, false, []],
    [["hsforms"], "HubSpot", true, ["HubSpot forms on your site"]],
    [
      ["salesforce", "pardot"],
      "Salesforce",
      true,
      [
        "Salesforce web-to-lead form on your site",
        "Pardot tracking on your site",
      ],
    ],
    [
      ["hsforms", "marketo"],
      "HubSpot and Marketo forms on your site",
      false,
      ["HubSpot forms", "Marketo forms"],
    ],
    [
      ["hsscripts", "salesforce"],
      "HubSpot tracking code and Salesforce web-to-lead form on your site",
      false,
      ["HubSpot tracking code", "Salesforce web-to-lead form"],
    ],
    [["pardot"], "Pardot tracking on your site", false, ["Pardot tracking"]],
  ];
  for (const [hosts, title, confirmed, sources] of golden) {
    const team = await researchTeamShape({
      domain: "acme.example",
      homepage: Promise.resolve({
        text: hosts.map((h) => HOSTS[h]).join(""),
        finalUrl: "https://acme.example/",
      }),
      fetchPage: async () => null,
    });
    const headline = crmHeadline(team);
    assert.equal(headline?.title ?? null, title, hosts.join("+"));
    assert.equal(team.crm.value !== "unknown", confirmed, hosts.join("+"));
    assert.deepEqual(
      headline?.sources.map((s) => s.label) ?? [],
      sources,
      hosts.join("+"),
    );
  }
});
