/**
 * Which CRM a homepage's scripts and forms point to.
 *
 * Precedence: a CRM is named only when a CRM's own fingerprint (HubSpot, or a Salesforce
 * web-to-lead form) is on the page and every other fingerprint belongs to the same vendor. Pardot is
 * Salesforce's own product. Marketo is Adobe's and syncs with Salesforce or Dynamics, so beside
 * HubSpot it is a second vendor. Any mix of vendors leaves the CRM unconfirmed, and the finding names
 * every tool found instead of picking one, so the evidence always supports the headline.
 */
type Fingerprint = {
  value: string;
  evidence: Array<{ url: string; quote: string }>;
};
type Crm = "hubspot" | "salesforce" | "other" | "none" | "unknown";

const VENDOR: Record<string, string> = {
  HubSpot: "hubspot",
  Salesforce: "salesforce",
  Pardot: "salesforce",
  Marketo: "adobe",
};
const CRM_NAME = {
  hubspot: "HubSpot",
  salesforce: "Salesforce",
  other: "Another CRM",
  none: "No CRM",
};

export function crmFromFingerprints(fingerprints: readonly Fingerprint[]) {
  const own = fingerprints.find(
    (f) => f.value === "HubSpot" || f.value === "Salesforce",
  );
  const vendors = new Set(fingerprints.map((f) => VENDOR[f.value] ?? f.value));
  if (!own || vendors.size !== 1) return null;
  return {
    value: VENDOR[own.value] as "hubspot" | "salesforce",
    evidence: fingerprints.flatMap((f) => f.evidence),
  };
}

/** What a script or form host shows: the tool, and what of it is on the page. */
function toolOnPage(quote: string, fallback: string) {
  if (/hsforms|hbspt\.forms|forms\.hubspot/i.test(quote))
    return { tool: "HubSpot", what: "forms" };
  if (/hs-scripts/i.test(quote))
    return { tool: "HubSpot", what: "tracking code" };
  if (/webto\.salesforce|webtolead/i.test(quote))
    return { tool: "Salesforce", what: "web-to-lead form" };
  if (/pardot/i.test(quote)) return { tool: "Pardot", what: "tracking" };
  if (/marketo|mkto/i.test(quote)) return { tool: "Marketo", what: "forms" };
  return { tool: fallback, what: "code" };
}
const and = (items: string[]) =>
  items.length < 2
    ? items.join("")
    : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;

/** Script and form hosts read as the tool they belong to. */
export function fingerprintLabel(quote: string) {
  const found = toolOnPage(quote, "");
  return found.tool ? `${found.tool} ${found.what} on your site` : quote;
}

/**
 * The CRM finding as shown: a headline and the evidence under it. A named CRM cites only its own
 * vendor's fingerprints; a mix of vendors is the headline itself ("HubSpot and Marketo forms on your
 * site") with each tool linked to the page it was found on, and stays unconfirmed.
 */
export function crmHeadline(team: {
  crm: { value: Crm; evidence: Array<{ url: string; quote: string }> };
  fingerprints: readonly Fingerprint[];
}): {
  title: string;
  confirmed: boolean;
  sources: Array<{ url: string; label: string }>;
} | null {
  if (team.fingerprints.length) {
    const named = crmFromFingerprints(team.fingerprints);
    if (named)
      return {
        title: CRM_NAME[named.value],
        confirmed: true,
        sources: named.evidence.map((e) => ({
          url: e.url,
          label: fingerprintLabel(e.quote),
        })),
      };
    const found = team.fingerprints.map((f) =>
      toolOnPage(f.evidence[0]?.quote ?? "", f.value),
    );
    const whats = new Set(found.map((f) => f.what));
    return {
      title: `${
        whats.size === 1
          ? `${and(found.map((f) => f.tool))} ${found[0].what}`
          : and(found.map((f) => `${f.tool} ${f.what}`))
      } on your site`,
      confirmed: false,
      sources: team.fingerprints.flatMap((f, i) =>
        f.evidence
          .slice(0, 1)
          .map((e) => ({
            url: e.url,
            label: `${found[i].tool} ${found[i].what}`,
          })),
      ),
    };
  }
  if (team.crm.value === "unknown") return null;
  return {
    title: CRM_NAME[team.crm.value],
    confirmed: true,
    sources: team.crm.evidence.map((e) => ({
      url: e.url,
      label: fingerprintLabel(e.quote),
    })),
  };
}
