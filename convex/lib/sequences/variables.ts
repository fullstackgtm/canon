export type VariableValues = Record<string, string>;
export type VariableTemplate = { subject: string; body: string };
export type VariableSample = { values: VariableValues; subject: string; body: string; problems: string[] };

export const cleanVariable = (value: unknown): string => value == null ? "" : String(value).trim().replace(/\s+/g, " ");
const uniformCase = (s: string) => s === s.toUpperCase() || s === s.toLowerCase();
const particles = new Set(["de", "del", "da", "di", "van", "von", "der", "la", "le", "of", "the", "and"]);
const acronyms = new Set(["IBM", "NASA", "NATO", "FBI", "CIA", "IRS", "EPA", "FDA", "SEC", "NHS", "USPS", "KPMG", "EY", "PWC", "BASF", "BHP", "BP", "TCS", "HCL", "AMD", "NEC", "NTT", "AIG", "AXA", "ING", "HSBC", "CEO", "CFO", "CTO", "COO", "CRO", "CMO", "VP", "SVP", "API", "BMW", "UPS", "DHL", "HP", "HPE", "SAP", "SAS", "AWS", "AT&T", "GE", "GM", "3M", "BBC", "ABC", "CBS", "NBC", "IT", "AI", "USA", "UK", "US", "HR", "PR", "SEO", "HVAC", "B2B", "B2C"]);
const properWord = (word: string) => word.toLowerCase().replace(/(^|[-'’])(\p{L})/gu, (_, prefix: string, letter: string) => prefix + letter.toUpperCase())
  .replace(/^Mc(\p{L})/u, (_, letter: string) => `Mc${letter.toUpperCase()}`);

export function normalizeFirstName(value: unknown): string {
  return cleanVariable(value).split(" ").map((word) => !uniformCase(word) ? word : particles.has(word.toLowerCase()) ? word.toLowerCase() : properWord(word)).join(" ");
}
export function normalizeCompanyName(value: unknown): string {
  let name = cleanVariable(value);
  const suffix = /(?:^|[\s,]+)(?:inc\.?|l\.?l\.?c\.?|ltd\.?|corp\.?|corporation|co\.?|gmbh|s\.?a\.?|plc)\s*$/i;
  while (suffix.test(name)) name = name.replace(suffix, "").replace(/[\s,]+$/, "");
  if (!uniformCase(name)) return name;
  return name.split(" ").map((word, i) => acronyms.has(word) ? word : i > 0 && particles.has(word.toLowerCase()) ? word.toLowerCase() : properWord(word)).join(" ");
}
export function normalizeVariables(input: Record<string, unknown>): VariableValues {
  const values = Object.fromEntries(Object.entries(input).map(([key, value]) => [key, cleanVariable(value)]));
  for (const key of ["to.name", "to.firstName", "sender.name"]) if (key in values) values[key] = normalizeFirstName(values[key]);
  for (const key of ["to.email", "sender.address", "company.domain"]) if (key in values) values[key] = values[key].toLowerCase();
  values["company.name"] = normalizeCompanyName(values["company.name"]);
  values["to.firstName"] = normalizeFirstName(values["to.firstName"]) || (values["company.name"] ? `${values["company.name"]} team` : "");
  return values;
}

const aliases: Record<string, string> = { name: "to.name", firstName: "to.firstName", first_name: "to.firstName", email: "to.email", company: "company.name", company_name: "company.name", "sender.email": "sender.address" };
const tokens = () => /\{\$([\w.]+)\}|\{\{\s*([\w.]+)(?:\s*\|\s*default\s+"([^"]*)")?\s*\}\}|\{([\w.]+)\}/g;
const keyOf = (name: string) => Object.hasOwn(aliases, name) ? aliases[name] : name;
export function variableFields(template: VariableTemplate): string[] {
  return [...new Set([template.subject, template.body].flatMap((s) => [...s.matchAll(tokens())].map((m) => keyOf(m[1] ?? m[2] ?? m[4]))))].sort();
}
export function renderVariables(template: VariableTemplate, input: Record<string, unknown>, emailStatus: unknown, usesEmail = true): VariableSample {
  const values = normalizeVariables(input), problems = new Set<string>(), renderedValues: VariableValues = Object.create(null);
  if (usesEmail && (emailStatus !== "valid" || !/^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/.test(values["to.email"] ?? ""))) problems.add("Email must have Canon status valid.");
  const fill = (text: string) => text.replace(tokens(), (token, a: string, b: string, fallback: string | undefined, c: string) => {
    const key = keyOf(a ?? b ?? c), value = (Object.hasOwn(values, key) ? values[key] : "") || (key === "to.firstName" ? "" : cleanVariable(fallback));
    renderedValues[key] = value;
    if (!value) { problems.add(`Required variable ${key} is empty.`); return token; }
    if (/\{[^{}]*\}/.test(value)) problems.add(`Variable ${key} contains a placeholder.`);
    if (!/(?:email|address|domain)$/.test(key) && value.split(/\s+/).some((word) => /\p{L}{2}/u.test(word) && word === word.toUpperCase() && !acronyms.has(word))) problems.add(`Variable ${key} is still all caps.`);
    return value;
  });
  const subject = fill(template.subject), body = fill(template.body);
  if (/\{[^{}]*\}/.test(subject + body) || subject.includes("{{") || body.includes("{{") || subject.includes("{$") || body.includes("{$")) problems.add("The message contains a leftover placeholder.");
  return { values: Object.fromEntries(variableFields(template).map((key) => [key, renderedValues[key] ?? values[key] ?? ""])), subject, body, problems: [...problems] };
}
