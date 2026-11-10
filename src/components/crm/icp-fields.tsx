"use client";

/**
 * The fields of an ICP spec (convex/lib/icps.ts): market, persona and
 * exclusions over the free sources' vocabularies. The ICPs page edits a saved
 * ICP with them; Add records starts a fill with them.
 */
import { useMemo, useState } from "react";
import { X } from "lucide-react";
import { INDUSTRIES, canonIndustry, industryLabel } from "../../../services/record-service/src/industries";
import { COUNTRIES, DEPARTMENTS, EMPLOYEE_BANDS, LEVELS, canonDepartments, type Market, type Persona } from "../../../convex/lib/addRecords";
import type { IcpExclude } from "../../../convex/lib/icpSpec";

export const label = "text-xs font-medium text-muted-foreground";
export const input = "w-full border border-border bg-background px-2 py-1.5 text-sm outline-none focus:border-primary";

export const titleCase = (s: string) => s.replace(/\b[a-z]/g, (c) => c.toUpperCase()).replace(/\bAnd\b/g, "and").replace(/\bIt\b/g, "IT");

function toggle(list: string[], value: string): string[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}

/** A row of toggle chips over a fixed vocabulary. A value outside it still counts, so it shows as a chip too. */
export function Chips({ options, value, onChange }: { options: Array<{ value: string; label: string }>; value: string[]; onChange: (next: string[]) => void }) {
  const all = [...options, ...value.filter((v) => !options.some((o) => o.value === v)).map((v) => ({ value: v, label: v }))];
  return (
    <div className="flex flex-wrap gap-1">
      {all.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={value.includes(o.value)}
          onClick={() => onChange(toggle(value, o.value))}
          className={`border px-2 py-0.5 text-xs ${value.includes(o.value) ? "border-primary bg-primary/10 text-foreground" : "border-border text-muted-foreground hover:text-foreground"}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Free-text values (job titles) entered as chips. */
export function TagInput({ value, onChange, placeholder }: { value: string[]; onChange: (next: string[]) => void; placeholder: string }) {
  const [draft, setDraft] = useState("");
  const add = () => {
    const t = draft.trim();
    if (t && !value.includes(t)) onChange([...value, t]);
    setDraft("");
  };
  return (
    <div className="flex flex-wrap items-center gap-1 border border-border px-2 py-1">
      {value.map((t) => (
        <span key={t} className="flex items-center gap-1 border border-border px-1.5 py-0.5 text-xs">
          {t}
          <button type="button" aria-label={`Remove ${t}`} onClick={() => onChange(value.filter((v) => v !== t))}><X className="size-3" /></button>
        </span>
      ))}
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === ",") {
            e.preventDefault();
            add();
          }
        }}
        onBlur={add}
        placeholder={value.length ? "" : placeholder}
        className="min-w-[10ch] flex-1 bg-transparent py-0.5 text-sm outline-none"
      />
    </div>
  );
}

/**
 * Industries: a searchable pick from the canonical list (services/record-service/src/industries.ts).
 * Searching any source's name ("computer software", "HOSPITAL_HEALTH_CARE") offers the industry it maps to.
 */
export function IndustryPicker({ value, onChange, ariaLabel = "Search industries" }: { value: string[]; onChange: (next: string[]) => void; ariaLabel?: string }) {
  const [q, setQ] = useState("");
  const matches = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return [];
    const exact = canonIndustry(needle);
    const hits = INDUSTRIES.filter((i) => i.key === exact || i.key.includes(needle) || i.label.toLowerCase().includes(needle));
    return hits.filter((i) => !value.includes(i.key)).slice(0, 12);
  }, [q, value]);
  return (
    <div className="grid gap-1">
      {value.length > 0 && <Chips options={value.map((v) => ({ value: v, label: industryLabel(v) }))} value={value} onChange={onChange} />}
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search industries (software, staffing, banking…)" className={input} aria-label={ariaLabel} />
      {matches.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {matches.map((m) => (
            <button key={m.key} type="button" onClick={() => { onChange([...value, m.key]); setQ(""); }} className="border border-dashed border-border px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground">
              + {m.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function PersonaFields({ value, onChange }: { value: Persona; onChange: (next: Persona) => void }) {
  return (
    <div className="grid gap-3">
      <div className="grid gap-1">
        <span className={label}>Seniority (none picked: C-suite, VP, Head, Director)</span>
        <Chips options={LEVELS} value={value.levels} onChange={(levels) => onChange({ ...value, levels })} />
      </div>
      <div className="grid gap-1">
        <span className={label}>Departments</span>
        <Chips options={DEPARTMENTS.map((d) => ({ value: d, label: d }))} value={canonDepartments(value.departments)} onChange={(departments) => onChange({ ...value, departments })} />
      </div>
      <div className="grid gap-1">
        <span className={label}>Job titles (optional)</span>
        <TagInput value={value.titles} onChange={(titles) => onChange({ ...value, titles })} placeholder="VP Sales, Head of RevOps… then Enter" />
      </div>
      <div className="grid gap-1">
        <span className={label}>Buyer location (where the person is; none picked: anywhere)</span>
        <Chips options={COUNTRIES} value={value.countries ?? []} onChange={(countries) => onChange({ ...value, countries })} />
      </div>
    </div>
  );
}

export function MarketFields({ value, onChange }: { value: Market; onChange: (next: Market) => void }) {
  return (
    <div className="grid gap-3">
      <div className="grid gap-1">
        <span className={label}>Industries</span>
        <IndustryPicker value={value.industries} onChange={(industries) => onChange({ ...value, industries })} />
      </div>
      <div className="grid gap-1">
        <span className={label}>Company size (employees)</span>
        <Chips options={EMPLOYEE_BANDS.map((b) => ({ value: b, label: b }))} value={value.employeeBands} onChange={(employeeBands) => onChange({ ...value, employeeBands })} />
      </div>
      <div className="grid gap-1">
        <span className={label}>Company location</span>
        <Chips options={COUNTRIES} value={value.countries} onChange={(countries) => onChange({ ...value, countries })} />
      </div>
    </div>
  );
}

/** What an ICP leaves out: fills skip it, and an account with it is outside the ICP. */
export function ExcludeFields({ value, onChange }: { value: IcpExclude; onChange: (next: IcpExclude) => void }) {
  return (
    <div className="grid gap-3">
      <div className="grid gap-1">
        <span className={label}>Exclude industries</span>
        <IndustryPicker value={value.industries} onChange={(industries) => onChange({ ...value, industries })} ariaLabel="Search industries to exclude" />
      </div>
      <div className="grid gap-1">
        <span className={label}>Exclude locations</span>
        <Chips options={COUNTRIES} value={value.countries} onChange={(countries) => onChange({ ...value, countries })} />
      </div>
      <div className="grid gap-1">
        <span className={label}>Exclude job titles</span>
        <TagInput value={value.titles} onChange={(titles) => onChange({ ...value, titles })} placeholder="Intern, Assistant… then Enter" />
      </div>
    </div>
  );
}

export const excludeCount = (e: IcpExclude) => e.industries.length + e.countries.length + e.titles.length;

/** An account AI field, as researchAgents.list returns it. */
export type AiField = { slug: string; label: string; kind: "classify" | "qa"; options: Array<{ key: string; label: string }> | null; answerType: "text" | "number" | "boolean" | null };

