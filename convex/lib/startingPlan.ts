import { v, type Infer } from "convex/values";

export const evidenceValidator = v.object({
  url: v.string(),
  quote: v.string(),
});
const fact = <T extends Parameters<typeof v.object>[0][string]>(value: T) =>
  v.object({ value, evidence: v.array(evidenceValidator) });
export const crmValue = v.union(
  v.literal("unknown"),
  v.literal("none"),
  v.literal("hubspot"),
  v.literal("salesforce"),
  v.literal("other"),
);
export const sellersValue = v.union(
  v.literal("unknown"),
  v.literal("0-2"),
  v.literal("3-10"),
  v.literal("11-49"),
  v.literal("50+"),
);
export const teamShapeValidator = v.object({
  crm: fact(crmValue),
  fingerprints: v.array(fact(v.string())),
  motion: fact(
    v.union(
      v.literal("unknown"),
      v.literal("self-serve"),
      v.literal("sales-led"),
      v.literal("hybrid"),
    ),
  ),
  hiring: fact(
    v.union(v.null(), v.object({ sales: v.number(), cs: v.number() })),
  ),
  sizeBand: fact(v.union(v.null(), v.string())),
});
export const onboardingAnswersValidator = v.object({
  crm: v.optional(crmValue),
  sellers: v.optional(sellersValue),
});
export const companyFindingValidator = v.object({
  brand: v.optional(v.object({
    logoUrl: v.optional(v.string()),
    color: v.optional(v.string()),
    sourceUrl: v.string(),
    customers: v.array(v.object({ name: v.string(), logoUrl: v.string() })),
  })),
  name: v.string(),
  summary: v.string(),
  evidence: v.array(evidenceValidator),
});
export const researchEventValidator = v.object({
  at: v.number(),
  kind: v.string(),
  text: v.string(),
  evidence: v.optional(v.array(evidenceValidator)),
});
export const startingPlanValidator = v.object({
  archetypes: v.array(
    v.union(
      v.literal("Z0"),
      v.literal("B1"),
      v.literal("S2"),
      v.literal("M3"),
      v.literal("G4"),
    ),
  ),
  persona: v.literal("unknown"),
  modules: v.array(
    v.object({
      id: v.string(),
      label: v.string(),
      why: v.string(),
      evidence: v.array(evidenceValidator),
    }),
  ),
  landing: v.string(),
  tasks: v.array(
    v.object({ id: v.string(), label: v.string(), href: v.string() }),
  ),
  questions: v.array(v.union(v.literal("crm"), v.literal("sellers"))),
});
export type Evidence = Infer<typeof evidenceValidator>;
export type TeamShape = Infer<typeof teamShapeValidator>;
export type OnboardingAnswers = Infer<typeof onboardingAnswersValidator>;
export type StartingPlan = Infer<typeof startingPlanValidator>;
export type CompanyFinding = Infer<typeof companyFindingValidator>;

export const unknownTeamShape = (): TeamShape => ({
  crm: { value: "unknown", evidence: [] },
  fingerprints: [],
  motion: { value: "unknown", evidence: [] },
  hiring: { value: null, evidence: [] },
  sizeBand: { value: null, evidence: [] },
});

export function buildStartingPlan(args: {
  team?: TeamShape;
  answers?: OnboardingAnswers;
  company?: CompanyFinding;
  segmentId?: string;
}): StartingPlan {
  const team = args.team ?? unknownTeamShape();
  const answers = args.answers ?? {};
  const crm = answers.crm ?? team.crm.value;
  const sellers = answers.sellers ?? "unknown";
  const answerEvidence = (quote: string): Evidence[] => [
    { url: "", quote: `You told us: ${quote}` },
  ];
  const crmEvidence = answers.crm
    ? answerEvidence(`CRM: ${crm}`)
    : team.crm.evidence;
  const sellerEvidence = answers.sellers
    ? answerEvidence(`Sellers: ${sellers}`)
    : [];
  const archetypes: StartingPlan["archetypes"] = [];
  if (crm === "none" && sellers === "0-2") archetypes.push("Z0");
  if (
    sellers === "3-10" ||
    (sellers === "unknown" && (team.hiring.value?.sales ?? 0) > 0)
  )
    archetypes.push("B1");
  if (
    (crm === "hubspot" || crm === "salesforce") &&
    (sellers === "11-49" || sellers === "50+")
  )
    archetypes.push("S2");
  if (sellers === "50+") archetypes.push("M3");
  if (
    (team.motion.value === "self-serve" || team.motion.value === "hybrid") &&
    (team.hiring.value?.cs ?? 0) > 0
  )
    archetypes.push("G4");
  const modules: StartingPlan["modules"] = [];
  const add = (
    id: string,
    label: string,
    why: string,
    evidence: Evidence[],
  ) => {
    if (!modules.some((m) => m.id === id) && modules.length < 6)
      modules.push({ id, label, why, evidence });
  };
  const researchEvidence = args.company?.evidence ?? [];
  if (researchEvidence.length) {
    add(
      "@canon/icps",
      "Ideal customers",
      "Review the buyers identified from your website.",
      researchEvidence,
    );
    add(
      "@canon/work",
      "Work",
      "Keep the first account reviews and follow-ups together.",
      researchEvidence,
    );
  }
  if (archetypes.includes("G4"))
    add(
      "@canon/customer-success",
      "Customer success",
      "Self-serve pricing and open customer roles suggest a post-sale focus.",
      [...team.motion.evidence, ...team.hiring.evidence],
    );
  if (archetypes.includes("S2") || archetypes.includes("M3")) {
    add(
      "@canon/reports",
      "Reports",
      "Review pipeline data across your sales team.",
      crmEvidence.length ? crmEvidence : sellerEvidence,
    );
    add(
      "@canon/forecast",
      "Forecast",
      "Review the pipeline across your sales team.",
      sellerEvidence,
    );
  }
  if (archetypes.includes("Z0") || archetypes.includes("B1")) {
    add(
      "@canon/sequences",
      "Sequences",
      "Prepare repeatable outreach to your best-fit accounts.",
      sellerEvidence.length ? sellerEvidence : team.hiring.evidence,
    );
    add(
      "@canon/dialer",
      "Dialer",
      "Work through the accounts you choose to call.",
      sellerEvidence.length ? sellerEvidence : team.hiring.evidence,
    );
  }
  const landing = args.segmentId
    ? `/dashboard/accounts?segment=${encodeURIComponent(args.segmentId)}`
    : "/dashboard/accounts";
  const tasks = [
    {
      id: "review_icp",
      label: "Review your ideal customers",
      href: "/dashboard/accounts",
    },
    { id: "triage_tam", label: "Choose your first accounts", href: landing },
    {
      id: "research_accounts",
      label: "Research the accounts you chose",
      href: landing,
    },
  ];
  if (archetypes.includes("S2"))
    tasks.splice(0, 1, {
      id: "connect_crm",
      label: `Connect ${crm === "salesforce" ? "Salesforce" : "HubSpot"}`,
      href: "/dashboard/integrations",
    });
  return {
    archetypes,
    persona: "unknown",
    modules,
    landing,
    tasks,
    questions: [
      ...(crm === "unknown" ? ["crm" as const] : []),
      ...(sellers === "unknown" ? ["sellers" as const] : []),
    ],
  };
}
