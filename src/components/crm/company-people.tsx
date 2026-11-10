"use client";

import { IntegrationGate } from "@/components/integration-gate";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAction } from "convex/react";
import { api } from "../../../convex/_generated/api";
import type { PeopleRead } from "../../../convex/companyPeople";
import { FINDER_STEPS } from "../../../convex/lib/tam/companyPeople";
import { CREDIT_RATES } from "../../../convex/lib/creditPacks";

const roleLabel = { decision_maker: "Decision maker", champion: "Champion", other: "Other" };
function CompanyPeopleEnabled({ accountId, websiteReading, onAdded }: { accountId: string; websiteReading: boolean; onAdded?: () => void }) {
  const read = useAction(api.companyPeople.read);
  const start = useAction(api.companyPeople.start);
  const [state, setState] = useState<PeopleRead | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState("");
  const completed = useRef<string | null>(null);
  const active = state?.run?.status === "running" || state?.run?.status === "queued";
  const load = useCallback(async () => {
    const next = await read({ accountId });
    setState(next);
    if (next.run?.completedAt && completed.current !== next.run._id) {
      completed.current = next.run._id;
      if (next.run.people.length) onAdded?.();
    }
  }, [read, accountId, onAdded]);
  useEffect(() => { void load().catch(() => setError("Could not load Find people.")); }, [load]);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => void load().catch(() => setError("Could not refresh the run. Reopen this company to read its result.")), 2_000);
    return () => clearInterval(timer);
  }, [active, load]);
  if (!state) return error ? <p role="alert" className="mt-4 text-sm">{error}</p> : null;
  if (!state.canFind) return null;
  return <div className="mt-4 border-t border-border pt-4" aria-label="Find people">
    <h3 className="text-sm font-medium">Find people to contact</h3>
    <p className="mt-1 text-sm text-muted-foreground">Up to {state.limit} people. {CREDIT_RATES.contact} credit per contact added{state.paid ? `, plus ${CREDIT_RATES.verifiedEmail} per valid email found` : ""}. Maximum {state.estimateCredits} credits. Duplicates and misses are free.</p>
    {!state.paid && <p className="mt-1 text-xs text-muted-foreground">Paid review replies, owner answers and email verification are skipped here. Free searches run normally.</p>}
    <button type="button" disabled={starting || active || websiteReading} className="mt-3 border border-border px-3 py-1.5 text-sm font-medium hover:bg-accent disabled:opacity-50" onClick={async () => {
      setStarting(true); setError("");
      try { await start({ accountId }); await load(); }
      catch (e) { setError(e instanceof Error ? e.message : "Could not start Find people."); }
      finally { setStarting(false); }
    }}>{starting || active ? "Finding people…" : `Find people · up to ${state.estimateCredits} credits`}</button>
    {error && <p role="alert" className="mt-2 text-sm text-destructive">{error}</p>}
    {state.run && <div className="mt-3 text-sm" aria-live="polite">
      <p>{active ? "Searching the company's buyers and public staff names." : `${state.run.people.length} contacts added · ${state.run.spentCredits} credits charged${state.run.status === "failed" ? " · Run did not finish" : ""}`}</p>
      {!active && <p className="mt-1 text-xs text-muted-foreground">{FINDER_STEPS.map((step) => `${step.label}: ${state.run!.sourceCounts[step.source] ?? 0}`).join(" · ")}</p>}
      <ul className="mt-3 space-y-3">{(state.contacts ?? []).map((person) => <li key={person.contactId} className="border-l-2 border-border pl-3">
        <p><a href={`/dashboard/records/contact/${encodeURIComponent(person.contactId)}`} className="font-medium underline">{person.fullName}</a> · {roleLabel[person.role]}{person.title ? ` · ${person.title}` : ""}</p>
        <p className="text-muted-foreground">{person.reasoning}</p>
        <a href={person.url} target="_blank" rel="noreferrer" className="underline">{FINDER_STEPS.find((step) => step.source === person.source)?.label}</a>
        {person.quote && <blockquote className="mt-1 text-muted-foreground">{person.quote}</blockquote>}
        <p className="mt-1 text-xs text-muted-foreground">{person.email ?? "No verified email"} · {person.emailStatus === "not_checked" ? "Email verification skipped" : person.emailStatus === "catch_all" ? "Catch-all · Not sendable" : person.emailStatus === "valid" ? "Valid · Sendable" : "Invalid · Not sendable"}</p>
      </li>)}</ul>
      {state.run.notes.map((note, index) => <p key={index} className="mt-2 text-xs text-muted-foreground">{note}</p>)}
    </div>}
  </div>;
}

export function CompanyPeople(props: React.ComponentProps<typeof CompanyPeopleEnabled>) {
  return <IntegrationGate feature="treg"><CompanyPeopleEnabled {...props} /></IntegrationGate>;
}
