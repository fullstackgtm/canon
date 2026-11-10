import { websiteText } from "../../modules/kernel/websiteSources.ts";
import { crmFromFingerprints } from "./crmFingerprints.ts";
import { unknownTeamShape, type TeamShape } from "./startingPlan.ts";

type Page = { text: string; finalUrl: string };
type FetchPage = (url: string) => Promise<Page | null>;
const SALES =
  /\b(account executive|sales|sdr|bdr|revenue operations|revops)\b/i;
const CS = /\b(customer success|account manager|customer experience)\b/i;

function links(page: Page): URL[] {
  return [...page.text.matchAll(/href\s*=\s*["']([^"']+)["']/gi)].flatMap(
    (m) => {
      try {
        const u = new URL(m[1].replace(/&amp;/g, "&"), page.finalUrl);
        return u.protocol === "https:" ? [u] : [];
      } catch {
        return [];
      }
    },
  );
}

export async function researchTeamShape(args: {
  domain: string;
  homepage: Promise<Page | null>;
  fetchPage: FetchPage;
}): Promise<TeamShape> {
  const result = unknownTeamShape();
  const home = await args.homepage;
  if (!home) return result;
  for (const [name, pattern] of [
    [
      "HubSpot",
      /(?:js\.hs-scripts\.com|js\.hsforms\.net|forms\.(?:hubspot|hsforms)\.com|hbspt\.forms\.create)/i,
    ],
    [
      "Salesforce",
      /(?:webto\.salesforce\.com|force\.com\/servlet\/servlet\.WebToLead)/i,
    ],
    ["Pardot", /(?:pi\.pardot\.com|go\.pardot\.com)/i],
    ["Marketo", /(?:munchkin\.marketo\.net|MktoForms2)/i],
  ] as const) {
    const match = home.text.match(pattern);
    if (match)
      result.fingerprints.push({
        value: name,
        evidence: [{ url: home.finalUrl, quote: match[0] }],
      });
  }
  const crm = crmFromFingerprints(result.fingerprints);
  if (crm) result.crm = crm;
  const homeLinks = links(home);
  const sameSite = (u: URL) => u.hostname.replace(/^www\./, "") === args.domain;
  const pricing = homeLinks.find(
    (u) => sameSite(u) && /^\/pricing\/?$/.test(u.pathname),
  );
  const careers = homeLinks.find(
    (u) => sameSite(u) && /^\/(careers|jobs)\/?$/.test(u.pathname),
  );
  const [pricePage, careerPage] = await Promise.all([
    pricing ? args.fetchPage(pricing.href) : Promise.resolve(null),
    careers ? args.fetchPage(careers.href) : Promise.resolve(null),
  ]);
  if (pricePage) {
    const text = websiteText(pricePage.text);
    const self = text.match(
      /\b(free plan|start for free|sign up free|start free trial|no credit card required)\b/i,
    );
    const sales = text.match(
      /\b(book a demo|request a demo|contact sales|talk to sales)\b/i,
    );
    if (self || sales)
      result.motion = {
        value: self && sales ? "hybrid" : self ? "self-serve" : "sales-led",
        evidence: [self, sales].flatMap((m) =>
          m ? [{ url: pricePage.finalUrl, quote: m[0] }] : [],
        ),
      };
  }
  const board = await readAtsBoard({ pages: [home, ...(careerPage ? [careerPage] : [])], fetchPage: args.fetchPage });
  if (!board) return result;
  const jobs = board.jobs;
  let sales = 0, cs = 0;
  const evidence: TeamShape["hiring"]["evidence"] = [];
  for (const { title } of jobs) {
    if (SALES.test(title)) sales++;
    if (CS.test(title)) cs++;
    if ((SALES.test(title) || CS.test(title)) && evidence.length < 6)
      evidence.push({ url: board.url, quote: title.slice(0, 180) });
  }
  result.hiring = {
    value: { sales, cs },
    evidence: [
      { url: board.apiUrl, quote: `${jobs.length} public open job postings; ${sales} sales and ${cs} customer roles` },
      ...evidence,
    ],
  };
  return result;
}

/** Read a public Greenhouse, Lever or Ashby board once for every website consumer. */
export async function readAtsBoard(args: { pages: Page[]; fetchPage: FetchPage }): Promise<{ url: string; apiUrl: string; jobs: { title: string }[] } | null> {
  const board = args.pages.flatMap(links).find(
    (u) =>
      /^(boards\.greenhouse\.io|job-boards\.greenhouse\.io|jobs\.lever\.co|jobs\.ashbyhq\.com)$/.test(
        u.hostname,
      ) && /^\/[a-zA-Z0-9_-]+\/?$/.test(u.pathname),
  );
  if (!board) return null;
  const slug = board.pathname.split("/")[1];
  const apiUrl = board.hostname.includes("greenhouse")
    ? `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`
    : board.hostname.includes("lever")
      ? `https://api.lever.co/v0/postings/${slug}?mode=json`
      : `https://api.ashbyhq.com/posting-api/job-board/${slug}`;
  const jobsPage = await args.fetchPage(apiUrl);
  if (!jobsPage) return null;
  try {
    const raw: unknown = JSON.parse(jobsPage.text);
    const jobs = Array.isArray(raw)
      ? raw
      : raw &&
          typeof raw === "object" &&
          "jobs" in raw &&
          Array.isArray(raw.jobs)
        ? raw.jobs
        : null;
    if (!jobs) return null;
    const listed: { title: string }[] = [];
    for (const job of jobs) {
      if (!job || typeof job !== "object" || ("isListed" in job && job.isListed === false)) continue;
      const title: unknown = "title" in job ? job.title : "text" in job ? job.text : null;
      if (typeof title !== "string") return null;
      listed.push({ title });
    }
    return { url: board.href, apiUrl, jobs: listed };
  } catch { return null; }
}
