import { canonIndustry } from "./industries.ts";

const INDUSTRY_RULES: Array<[RegExp, string[]]> = [
  [/(saas|software|developer|devtools|platform|b2b tech)/, ["software development"]],
  [/(internet|online|marketplace|e-?commerce|web)/, ["technology, information and internet"]],
  [/(\bit\b|information technology|cloud|\bdata\b)/, ["it services and it consulting"]],
  [/(cyber|security)/, ["computer and network security"]],
  [/(fintech|financial|payments|lending|wealth)/, ["financial services"]],
  [/(invest|venture|private equity)/, ["investment management", "venture capital and private equity principals"]],
  [/bank/, ["banking"]],
  [/insur/, ["insurance"]],
  [/(marketing|advertising|agency)/, ["advertising services"]],
  [/media/, ["media production", "online audio and video media"]],
  [/(health|medical|hospital|clinic)/, ["hospitals and health care", "medical practices"]],
  [/(biotech|life science)/, ["biotechnology research"]],
  [/pharma/, ["pharmaceutical manufacturing"]],
  [/(staffing|recruit|talent)/, ["staffing and recruiting"]],
  [/(\bhr\b|human resources)/, ["human resources services"]],
  [/(consult|professional services|advisory)/, ["business consulting and services"]],
  [/(real estate|property|proptech)/, ["real estate"]],
  [/(retail|dtc|cpg|consumer goods)/, ["retail"]],
  [/(education|e-learning|edtech|learning)/, ["e-learning providers"]],
  [/(logistics|supply chain|freight|shipping)/, ["transportation, logistics, supply chain and storage"]],
  [/telecom/, ["telecommunications"]],
  [/wireless/, ["wireless services"]],
  [/construct/, ["construction"]],
  [/account/, ["accounting"]],
  [/(automotive|mobility)/, ["motor vehicle manufacturing"]],
  [/manufactur/, ["manufacturing"]],
  [/(legal|\blaw\b)/, ["law practice", "legal services"]],
  [/(hospitality|hotel)/, ["hospitality"]],
  [/restaurant/, ["restaurants"]],
  [/non-?profit/, ["non-profit organizations"]],
  [/(oil|gas)/, ["oil and gas"]],
  [/utilit/, ["utilities"]],
  [/gam(e|ing)/, ["computer games", "mobile gaming apps"]],
  [/(semiconductor|chip)/, ["semiconductor manufacturing"]],
  [/market research/, ["market research"]],
  [/(wholesale|distribut)/, ["wholesale"]],
  [/travel/, ["travel arrangements"]],
  [/(fitness|wellness)/, ["wellness and fitness services"]],
  [/(government|public sector)/, ["government administration"]],
];

/**
 * Industry labels as canonical industries. Any source's name for an industry maps exactly
 * (industries.ts). The rules above only read free text no table names (an LLM's "B2B SaaS"),
 * when an ICP is written: the result is what the ICP stores and shows, and nothing matches
 * accounts through a rule.
 */
export function icpIndustriesToLeadsforge(industries: string[] | undefined): string[] {
  const out = new Set<string>();
  for (const label of industries ?? []) {
    const canon = canonIndustry(label);
    if (canon) {
      out.add(canon);
      continue;
    }
    const l = label.toLowerCase().trim();
    for (const [re, mapped] of INDUSTRY_RULES) if (re.test(l)) mapped.forEach((m) => out.add(m));
  }
  return [...out];
}

