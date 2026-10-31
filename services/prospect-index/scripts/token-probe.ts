// Where do input tokens go? Marginal cost per company for each question style.
import { systemOne, type Question } from "../src/jev/client.ts";
import { archetypes } from "../src/jev/taxonomy.ts";
const tax = archetypes();
const keys = Object.keys(tax.groups);
const defs = Object.fromEntries(Object.entries(tax.groups).map(([k, g]) => [k, `${g.label}: ${g.definition}`]));
const co = { name: "midwest tractor & equipment", website: "midwesttractor.com", industry: "machinery", employees: "51-200" };
async function cost(n: number, style: string) {
  const q: Record<string, Question> = {};
  for (let j = 0; j < n; j++) {
    q[`c${j}`] = style === "nullCriteria"
      ? { type: "choice", instructions: `Which category in \`categories\` best describes the business \`companies[${j}]\`?`, criteria: Object.fromEntries(keys.map((k) => [k, null])) }
      : style === "shortInstr"
      ? { type: "choice", instructions: `Category of \`companies[${j}]\`?`, criteria: Object.fromEntries(keys.map((k) => [k, null])) }
      : { type: "choice", instructions: `Which category best describes the business \`companies[${j}]\`?`, criteria: defs };
  }
  const r = await systemOne({ categories: defs, companies: Array.from({ length: n }, () => co) }, q);
  return r.usage!.input_tokens;
}
for (const style of ["nullCriteria", "shortInstr", "inlineDefs"]) {
  const a = await cost(1, style), b = await cost(25, style);
  console.log(style.padEnd(13), `1 co: ${a} tok | 25 co: ${b} tok | marginal per company: ${Math.round((b - a) / 24)} | fixed: ${a - Math.round((b - a) / 24)}`);
}
