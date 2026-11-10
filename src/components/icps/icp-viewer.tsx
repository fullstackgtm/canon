import type { ReactNode } from "react";
import { parseQuery, serializeQuery, type Clause, type NodeKind } from "../../../convex/lib/icpQuery";
import { COUNTRIES, LEVELS } from "../../../convex/lib/icpVocabulary";
import { INDUSTRIES } from "../../../services/record-service/src/industries";

export type IcpViewerProps = {
  query: string;
  kind?: NodeKind;
  name?: string;
  children?: ReactNode;
  showQuery?: boolean;
  queryEditor?: ReactNode;
  className?: string;
};

export const labels: Record<Clause["key"], string> = {
  industry: "Industries", size: "Company size", country: "Countries", region: "Regions", city: "Cities", owner: "Owners",
  revenue: "Annual revenue", field: "Company field", level: "Seniority", dept: "Departments", title: "Titles", location: "Person location",
};
const title = (value: string) => value.charAt(0).toUpperCase() + value.slice(1).replace(/-/g, " ");
const number = (value: string) => Number(value).toLocaleString("en-US");
export function valueLabel(key: Clause["key"], value: string): string {
  if (key === "industry") return INDUSTRIES.find((i) => i.key === value)?.label ?? title(value);
  if (key === "size") return `${value.split("-").map((v) => v.endsWith("+") ? `${number(v.slice(0, -1))}+` : number(v)).join("–")} employees`;
  if (key === "level") return LEVELS.find((l) => l.value === value)?.label ?? title(value);
  if (key === "country" || key === "location") {
    const flag = /^[a-z]{2}$/i.test(value) ? String.fromCodePoint(...[...value.toUpperCase()].map((c) => c.charCodeAt(0) + 127397)) : "";
    return `${flag} ${COUNTRIES.find((c) => c.value === value)?.label ?? value.toUpperCase()}`.trim();
  }
  return key === "title" || key === "field" || key === "owner" ? value : title(value);
}
function Filters({ clauses }: { clauses: Clause[] }) {
  return <dl className="space-y-2">{clauses.map((c, i) => <div key={i}>
    <dt className="mb-1 text-[11px] font-medium text-muted-foreground">{c.neg ? "Exclude " : ""}{c.key === "field" ? title(c.slug) : labels[c.key]}</dt>
    <dd className="flex flex-wrap gap-1">{(c.values ?? [c.key === "field" ? `${c.min ?? "Any"} to ${c.max ?? "any"}` : ""]).map((v) =>
      <span key={v} className="max-w-full break-words rounded-sm border border-border bg-muted/50 px-1.5 py-0.5 text-xs text-foreground">{valueLabel(c.key, v)}</span>)}</dd>
  </div>)}</dl>;
}

/** No workspace hooks. Public onboarding can pass query alone; authenticated callers opt into Query. */
export function IcpViewer({ query, kind = "icp", name, children, showQuery = false, queryEditor, className = "" }: IcpViewerProps) {
  const parsed = parseQuery(query, kind);
  return <section aria-label={name ?? (kind === "persona" ? "Persona" : "Company target")} className={`min-w-0 space-y-3 font-sans ${className}`}>
    {name && <h3 className="font-display text-base text-primary">{name}</h3>}
    {parsed.query.clauses.length > 0 ? <Filters clauses={parsed.query.clauses} /> : kind !== "persona" && <p className="text-xs text-muted-foreground">All companies</p>}
    {parsed.query.has.map((h, i) => <section key={i} className="space-y-2 border-l-2 border-primary/30 pl-3" aria-label={h.neg ? "Excluded persona" : "Buyer persona"}>
      <h4 className="font-display text-sm text-primary">{h.neg ? "Without these people" : "Buyer persona"}</h4>
      <Filters clauses={h.clauses} />
    </section>)}
    {parsed.errors.length > 0 && <p className="text-xs text-muted-foreground">Some saved conditions need review.</p>}
    {children && <div className="space-y-4 border-l border-primary/30 pl-3">{children}</div>}
    {showQuery && <details className="text-xs" onClick={(event) => event.stopPropagation()}><summary className="w-fit cursor-pointer text-muted-foreground">Query</summary>
      <div className="mt-2">{queryEditor ?? <code className="block whitespace-pre-wrap break-words text-muted-foreground">{serializeQuery(parsed) || "All companies"}</code>}</div>
    </details>}
  </section>;
}
