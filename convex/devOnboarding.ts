import { ConvexError, v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { isDevAuthBypassEnabled } from "./lib";
import { buildStartingPlan, unknownTeamShape } from "./lib/startingPlan";

export const seed = internalMutation({
  args: {
    scenario: v.union(
      v.literal("ready"),
      v.literal("pending"),
      v.literal("failed"),
      v.literal("rich"),
    ),
  },
  handler: async (ctx, { scenario }) => {
    if (!isDevAuthBypassEnabled())
      throw new ConvexError("Local fixtures are disabled.");
    const token = `0000000000000000000000000000000${{ ready: "1", pending: "2", failed: "3", rich: "4" }[scenario]}`;
    const existing = await ctx.db
      .query("researchSessions")
      .withIndex("by_token", (q) => q.eq("token", token))
      .first();
    if (scenario === "rich") {
      // Re-seeding replaces the row, so fixture edits reach a running stack.
      const doc = { token, ...richFixture(Date.now()) };
      if (existing) await ctx.db.replace(existing._id, doc);
      else await ctx.db.insert("researchSessions", doc);
      return { token };
    }
    if (existing) return { token };
    const evidence = [
      {
        url: "https://dossier.example/",
        quote:
          "Synthetic fixture: scheduling software for distributed software sales teams.",
      },
    ];
    const companyFinding = {
      name: "Dossier Demo",
      summary:
        "Synthetic fixture. Scheduling software for distributed software sales teams.",
      evidence,
      brand: {
        color: "#7a2232",
        sourceUrl: "https://dossier.example/",
        customers: [],
      },
    };
    const teamShape = unknownTeamShape();
    teamShape.crm = {
      value: "hubspot",
      evidence: [
        {
          url: "https://dossier.example/",
          quote: "Synthetic fixture: js.hs-scripts.com",
        },
      ],
    };
    teamShape.motion = {
      value: "sales-led",
      evidence: [
        {
          url: "https://dossier.example/pricing",
          quote: "Synthetic fixture: book a demo for your sales team.",
        },
      ],
    };
    teamShape.hiring = {
      value: { sales: 2, cs: 1 },
      evidence: [
        {
          url: "https://dossier.example/careers",
          quote:
            "Synthetic fixture: two open sales roles and one customer role.",
        },
      ],
    };
    teamShape.sizeBand = {
      value: "51 employees",
      evidence: [
        {
          url: "",
          quote: "Synthetic fixture: 51 employees in the test prospect index.",
        },
      ],
    };
    const account = {
      name: "Example Software",
      domain: "example-software.example",
      industry: "computer software",
      employees: 100,
    };
    const icp = {
      name: "Software sales teams",
      firmographics: {
        industries: ["computer software"],
        employeeBands: ["51-200"],
        geos: ["US"],
      },
      persona: {
        jobLevels: ["vp", "director"],
        departments: ["sales"],
        titleKeywords: ["Revenue Operations"],
      },
    };
    const now = Date.now();
    await ctx.db.insert("researchSessions", {
      token,
      domain: "dossier.example",
      status:
        scenario === "pending"
          ? "building_tam"
          : scenario === "failed"
            ? "failed"
            : "ready",
      companyFinding,
      teamShape,
      icp,
      icpSource: "llm",
      startingPlan: buildStartingPlan({
        company: companyFinding,
        team: teamShape,
      }),
      ...(scenario === "ready"
        ? {
            tamTotal: 120,
            segments: [
              {
                id: "seg-computer-software-smb",
                name: "Computer Software · SMB",
                count: 12,
              },
            ],
            preview: [
              account,
              ...Array.from({ length: 11 }, (_, i) => ({
                ...account,
                name: `Synthetic Account ${i + 2}`,
                domain: `account-${i + 2}.example`,
              })),
            ].map((row, i) => ({ ...row, id: String(i), fit: 0.9 - i * 0.02 })),
            briefStatus: "ready" as const,
            brief: {
              positioning: [
                {
                  kind: "claim" as const,
                  text: "The site describes scheduling for distributed sales teams.",
                  evidence,
                },
                {
                  kind: "recommendation" as const,
                  text: "Test an angle focused on coordinating distributed sales teams.",
                  evidence,
                },
              ],
              drafts: [
                {
                  segment: "Computer Software · SMB",
                  persona: "Revenue Operations",
                  account: { name: account.name, domain: account.domain },
                  pain: "Could coordinating a distributed sales team make scheduling harder?",
                  subject: "Scheduling across your sales team",
                  body: "Hello Revenue Operations team,\n\nDoes coordinating a distributed sales team make scheduling harder at Example Software? Dossier describes scheduling software built for distributed software sales teams. Would it be useful to compare how you coordinate calendars today with that approach?\n\nThis is a synthetic draft for a local UI check.",
                  positioningIndex: 1,
                  evidence,
                },
              ],
            },
          }
        : {}),
      ...(scenario === "failed"
        ? {
            error: "Synthetic fixture: website evidence could not be verified.",
          }
        : {}),
      events: [
        {
          at: now,
          kind: "company",
          text: "Synthetic fixture: company evidence verified.",
          evidence,
        },
        {
          at: now + 1,
          kind: "team",
          text: "Synthetic fixture: public team signals checked.",
        },
        {
          at: now + 2,
          kind: scenario === "ready" ? "ready" : "building_tam",
          text: "Synthetic fixture for local verification. No provider was called.",
        },
      ],
      createdAt: now,
      updatedAt: now,
    });
    return { token };
  },
});

/** Long segment, persona and account names shaped like a real agency-market session, for layout checks. */
function richFixture(now: number) {
  const site = "https://creative-data.example/";
  const quote = (url: string, text: string) => [{ url, quote: `Synthetic fixture: ${text}` }];
  const companyFinding = {
    name: "Creative Data Demo",
    summary: "Synthetic fixture. Creative analytics that score ad creative before and after launch for brand and performance marketing teams.",
    evidence: [
      ...quote(site, "the creative intelligence platform that tells you which ads will work before you spend."),
      ...quote(`${site}platform`, "score every asset against your brand guidelines and past performance across every channel."),
      ...quote(`${site}customers`, "trusted by global brands and their agencies to make creative decisions with data."),
    ],
    brand: {
      color: "#5b3fd9",
      sourceUrl: site,
      customers: ["Northwind Foods", "Contoso Beverages", "Fabrikam Retail", "Tailspin Media", "Litware Apparel", "Adatum Beauty", "Proseware Auto"].map((name) => ({ name, logoUrl: "/fixture-missing-logo.png" })),
    },
  };
  const teamShape = {
    // HubSpot and Marketo are two vendors, so detection leaves the CRM unconfirmed.
    crm: { value: "unknown" as const, evidence: [] },
    fingerprints: [
      { value: "HubSpot", evidence: [{ url: site, quote: "js.hsforms.net" }] },
      { value: "Marketo", evidence: [{ url: site, quote: "MktoForms2" }] },
    ],
    motion: { value: "sales-led" as const, evidence: [{ url: `${site}pricing`, quote: "Request a demo" }] },
    hiring: { value: { sales: 3, cs: 2 }, evidence: [{ url: "https://boards.greenhouse.example/creativedata", quote: "Synthetic fixture: 3 sales and 2 customer success postings." }] },
    sizeBand: { value: "201-500 employees", evidence: [{ url: "", quote: "Synthetic fixture: 340 employees in the test prospect index." }] },
  };
  const rows: Array<[string, string, number]> = [
    ["ogilvyone worldwide", "marketing and advertising", 4200],
    ["Northbeam Media Partners International", "marketing and advertising", 2600],
    ["Bluefin Creative Group", "marketing and advertising", 1800],
    ["Harbor & Pine Agency", "marketing and advertising", 650],
    ["Copperline Media", "marketing and advertising", 480],
    ["Lumen Commerce", "retail", 9000],
    ["Fieldstone Brands", "consumer goods", 5200],
    ["Vectorworks Software", "computer software", 1500],
    ["Brightwave Retail Group", "retail", 3100],
    ["Quarry Street Studios", "marketing and advertising", 300],
    ["Meridian Consumer Co", "consumer goods", 2400],
    ["Signal Peak Analytics", "computer software", 2200],
  ];
  const preview = rows.map(([name, industry, employees], i) => ({
    id: String(i),
    name,
    domain: `${name.toLowerCase().replace(/[^a-z]+/g, "-")}.example`,
    industry,
    employees,
    fit: 0.94 - i * 0.03,
  }));
  const segments = [
    { id: "seg-marketing-and-advertising-ent", name: "Marketing and Advertising · Enterprise", count: 46 },
    { id: "seg-marketing-and-advertising-mid", name: "Marketing and Advertising · Mid-market", count: 31 },
    { id: "seg-retail-ent", name: "Retail · Enterprise", count: 18 },
    { id: "seg-consumer-goods-ent", name: "Consumer Goods · Enterprise", count: 14 },
    { id: "seg-computer-software-ent", name: "Computer Software · Enterprise", count: 9 },
    { id: "seg-marketing-and-advertising-smb", name: "Marketing and Advertising · SMB", count: 6 },
  ];
  const persona = "VP Marketing or Head of Media or Director of Creative Strategy or Head of Brand";
  const draft = (segment: string, account: string, domain: string, subject: string, body: string) => ({
    segment,
    persona,
    account: { name: account, domain },
    pain: `Could creative decisions at ${account} still rely on opinion before media spend is committed?`,
    subject,
    body,
    positioningIndex: 2,
    evidence: companyFinding.evidence.slice(0, 2),
  });
  return {
    domain: "creative-data.example",
    status: "ready" as const,
    companyFinding,
    teamShape,
    icp: {
      name: "Brand and agency marketing teams",
      firmographics: { industries: ["marketing and advertising", "retail", "consumer goods", "computer software"], employeeBands: ["1001-5000", "5001-10000", "201-500"], geos: ["US", "GB", "CA", "DE"] },
      persona: { jobLevels: ["vp", "director", "head"], departments: ["marketing"], titleKeywords: ["VP Marketing", "Head of Media", "Director of Creative Strategy", "Head of Brand"] },
    },
    icpSource: "llm" as const,
    startingPlan: buildStartingPlan({ company: companyFinding, team: teamShape, segmentId: segments[0].id }),
    tamTotal: 48210,
    filter: { saturated: false, source: "quickenrich" },
    segments,
    preview,
    marketSegments: {
      buyers: [
        { archetype: "media/agency", label: "Creative and media agencies", group: "media", kind: "buyer" as const, score: 0.9, why: "Agencies produce and test creative for many brands at once and need evidence before a client review.", pdlIndustries: ["marketing and advertising"], estCount: 21400, countBasis: "industry" as const },
        { archetype: "retail/brand", label: "Consumer brands with in-house creative", group: "retail", kind: "buyer" as const, score: 0.8, why: "Large brand teams run paid social at volume and need to know which assets to fund.", pdlIndustries: ["retail", "consumer goods"], estCount: 18900, countBasis: "industry" as const },
        { archetype: "software/b2b", label: "B2B software marketing teams", group: "software", kind: "buyer" as const, score: 0.6, why: "Demand generation teams test ad creative across LinkedIn and search.", pdlIndustries: ["computer software"], estCount: 7900, countBasis: "tagged" as const },
      ],
      adjacent: [],
      horizontal: false,
      jobs: ["Pick the ad creative most likely to perform before spending media budget."],
    },
    briefStatus: "ready" as const,
    brief: {
      positioning: [
        { kind: "claim" as const, text: "The site says it predicts which ads will work before media is spent.", evidence: companyFinding.evidence.slice(0, 1) },
        { kind: "claim" as const, text: "It scores creative against brand guidelines and past results on every channel.", evidence: companyFinding.evidence.slice(1, 2) },
        { kind: "recommendation" as const, text: "Lead with the cost of a creative decision made on opinion: show the score before the media plan is locked.", evidence: companyFinding.evidence.slice(0, 2) },
        { kind: "recommendation" as const, text: "For agencies, frame scores as evidence to bring to the client review.", evidence: companyFinding.evidence.slice(2, 3) },
      ],
      drafts: [
        draft(segments[0].name, "ogilvyone worldwide", preview[0].domain, "Scoring creative before the media plan locks",
          "Hi,\n\nWhen your teams take a campaign to a client review, how much of the creative choice rests on data rather than the room's opinion?\n\nCreative Data Demo scores each asset against brand guidelines and past performance before spend, so the review starts from evidence. Agencies use those scores to defend a recommendation instead of re-litigating it.\n\nWould it be useful to compare how ogilvyone worldwide picks assets today with a scored approach on one live brief? I can send a short example built on public ads.\n\nThis is a synthetic draft for a local UI check."),
        draft(segments[2].name, "Lumen Commerce", preview[5].domain, "Which ads to fund this quarter",
          "Hi,\n\nRetail teams running paid social at volume often fund more variants than they can learn from. Is that true at Lumen Commerce?\n\nCreative Data Demo scores creative before launch, so budget follows the assets most likely to perform. Would a short comparison on one campaign help?\n\nThis is a synthetic draft for a local UI check."),
        draft(segments[3].name, "Fieldstone Brands", preview[6].domain, "Creative evidence for your next launch",
          "Hi,\n\nBefore a product launch, how does Fieldstone Brands decide which creative gets the biggest share of spend?\n\nCreative Data Demo scores each asset against brand rules and past results. Would it help to see a scored example on public ads from your category?\n\nThis is a synthetic draft for a local UI check."),
      ],
    },
    events: [
      { at: now, kind: "reading", text: "Read the homepage and 4 linked pages." },
      { at: now + 1, kind: "company", text: "Verified 3 quotes about the offer.", evidence: companyFinding.evidence },
      { at: now + 2, kind: "model", text: "Derived a buyer profile: brand and agency marketing teams." },
      { at: now + 3, kind: "segments", text: "Grouped buyers into 3 segments." },
      { at: now + 4, kind: "team", text: "Checked CRM fingerprints, pricing and public hiring." },
      { at: now + 5, kind: "building_tam", text: "Found 48,210 matching companies." },
      { at: now + 6, kind: "sampling_contacts", text: "Scored a sample of 124 accounts for fit." },
      { at: now + 7, kind: "ready", text: "Synthetic fixture for local verification. No provider was called." },
    ],
    createdAt: now,
    updatedAt: now,
  };
}
