import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { buildSync } from "esbuild";
import { createElement, type ComponentType, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  CARD_IDS,
  CARD_LABELS,
  type ScreenId,
} from "../src/app/start/research-reveal-state.ts";

const require = createRequire(import.meta.url);
const built = buildSync({
  entryPoints: ["src/app/start/[token]/page.tsx"],
  bundle: true,
  write: false,
  loader: { ".css": "empty" },
  format: "cjs",
  platform: "neutral",
  jsx: "automatic",
  external: [
    "../research-reveal",
    "motion/react",
    "react",
    "react/*",
    "next/*",
    "lucide-react",
    "convex/react",
    "*/convex/_generated/api",
    "@/components/ui/dialog",
  ],
});
const evidence = [
  {
    url: "https://acme.example/product",
    quote: "Scheduling for software revenue teams",
  },
];
function render(screen: ScreenId, invited = false) {
  const session = {
    token: "test",
    domain: "acme.example",
    status: "ready",
    invited,
    waitlisted: false,
    briefStatus: "ready",
    icp: {
      name: "Acme buyers",
      firmographics: {
        industries: ["computer software"],
        employeeBands: ["51-200"],
        geos: ["US", "Canada"],
      },
      persona: {
        jobLevels: ["vp", "director"],
        departments: ["sales"],
        titleKeywords: ["Revenue Operations"],
      },
    },
    events: [],
    feedback: [],
    onboardingAnswers: {},
    tamTotal: 42,
    companyFinding: {
      name: "Acme",
      summary: "Sales software",
      evidence,
      brand: { customers: [{ name: "Customer Co", logoUrl: "/customer.svg" }] },
    },
    marketSegments: {
      buyers: [
        {
          archetype: "software_tech/b2b_saas",
          label: "Software teams",
          why: "Sell annual subscriptions.",
          estCount: 120,
        },
      ],
    },
    segments: [
      { id: "seg-computer-software-smb", name: "Software · SMB", count: 42 },
    ],
    preview: [
      {
        id: "a",
        name: "Example Buyer",
        domain: "buyer.example",
        industry: "computer software",
        employees: 100,
        fit: 0.87,
      },
    ],
    teamShape: {
      crm: {
        value: "hubspot",
        evidence: [{ url: "https://acme.example/", quote: "js.hsforms.net" }],
      },
      fingerprints: [
        {
          value: "HubSpot",
          evidence: [{ url: "https://acme.example/", quote: "js.hsforms.net" }],
        },
      ],
      motion: { value: "sales-led", evidence },
      hiring: { value: { sales: 2, cs: 0 }, evidence },
      sizeBand: { value: null, evidence: [] },
    },
    brief: {
      positioning: [
        {
          kind: "recommendation",
          text: "Lead with revenue team scheduling",
          evidence,
        },
      ],
      drafts: [
        {
          segment: "Software teams",
          persona: "Revenue Operations",
          account: { name: "Example Buyer", domain: "buyer.example" },
          pain: "Does coordinating calendars slow your team?",
          subject: "Team scheduling",
          body: "Does coordinating your software sales team's calendars cause friction? Could we compare approaches?",
          positioningIndex: 0,
          evidence,
        },
      ],
    },
  };
  const childrenOnly = ({ children }: { children?: ReactNode }) => children;
  const motion = new Proxy(
    {},
    {
      get:
        (_, tag: string) =>
        ({
          children,
          className,
          style,
        }: {
          children?: ReactNode;
          className?: string;
          style?: object;
        }) =>
          createElement(tag, { className, style }, children),
    },
  );
  const stubs: Record<string, unknown> = {
    "../research-reveal": {
      CARD_LABELS,
      useResearchReveal: () => ({
        screen,
        frontier: 10,
        revealed: CARD_IDS,
        reduced: true,
        events: [],
        settled: true,
        navigate: () => {},
        move: () => {},
      }),
    },
    "motion/react": {
      LayoutGroup: childrenOnly,
      AnimatePresence: childrenOnly,
      motion,
      useMotionValue: (value: number) => value,
      useTransform: (value: number, transform: (value: number) => string) =>
        transform(value),
      animate: () => ({ stop() {} }),
    },
    "next/link": ({ href, children }: { href: string; children: ReactNode }) =>
      createElement("a", { href }, children),
    "next/image": () => null,
    "next/navigation": { useParams: () => ({ token: "test" }) },
    "convex/react": { useQuery: () => session, useMutation: () => () => {} },
    "@/components/ui/dialog": {
      Dialog: ({ open, children }: { open: boolean; children?: ReactNode }) =>
        open ? children : null,
      DialogContent: childrenOnly,
      DialogTitle: childrenOnly,
      DialogDescription: childrenOnly,
    },
    "../../../../convex/_generated/api": { api: { researchSessions: {} } },
  };
  const compiled = { exports: {} as { default: ComponentType } };
  runInNewContext(built.outputFiles[0].text, {
    module: compiled,
    exports: compiled.exports,
    URL,
    require: (id: string) =>
      Object.hasOwn(stubs, id) ? stubs[id] : require(id),
  });
  return renderToStaticMarkup(createElement(compiled.exports.default));
}

test("onboarding shows one evidence-backed screen at a time, including the nested ICP and actual account examples", () => {
  const offer = render("offer");
  assert.ok(offer.includes("Sales software") && offer.includes("Customer Co"));
  assert.ok(offer.includes('href="https://acme.example/product"'));
  const buyers = render("buyers");
  for (const label of [
    "Software Development",
    "51–200 employees",
    "United States",
    "Canada",
    'aria-label="Buyer persona"',
    "VP",
    "Director",
    "Revenue Operations",
    "Software teams",
  ])
    assert.ok(buyers.includes(label), label);
  assert.ok(!/<code|industry:|size:|country:|has\(/.test(buyers));
  const market = render("market");
  assert.ok(market.includes('aria-label="Market map"'));
  assert.ok(
    market.includes("Example Buyer") &&
      market.includes("87") &&
      market.includes("% fit"),
  );
  const team = render("team");
  assert.ok(
    team.includes("HubSpot forms on your site") &&
      !team.includes("js.hsforms.net") &&
      team.includes("Sales-led") &&
      team.includes("2 sales roles"),
  );
  for (const screen of ["offer", "market", "buyers", "team", "plan"] as const)
    assert.ok(
      !/Building live|Research continues automatically|Agent Activity/.test(
        render(screen),
      ),
      screen,
    );
});

test("the final screen offers one draft and one waitlist action, exposing workspace access only for invitations", () => {
  const html = render("waitlist");
  for (const label of [
    "Research recap",
    "Revenue Operations",
    "Example Buyer",
    "Team scheduling",
    'name="website"',
    'type="email"',
    ">account segment<",
  ])
    assert.ok(html.includes(label), label);
  assert.equal(
    html.match(/<button[^>]*>[^<]*waitlist[^<]*<\/button>/gi)?.length,
    1,
  );
  assert.ok(!html.includes("/sign-up") && !html.includes("/claim"));
  assert.ok(render("waitlist", true).includes("/start/test/claim"));
  const positioning = render("plan");
  assert.ok(positioning.includes("Lead with revenue team scheduling"));
  assert.ok(positioning.includes("no comparison is asserted"));
});
