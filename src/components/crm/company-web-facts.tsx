"use client";

import { useEffect, useState, type ReactNode } from "react";
import { useAction } from "convex/react";
import { api } from "../../../convex/_generated/api";
import type { WebsiteFactsRead } from "../../../convex/companyWebFacts";
import { CompanyPeople } from "./company-people";

function Source({ url, children }: { url: string; children: ReactNode }) {
  return <a href={url} target="_blank" rel="noreferrer" className="underline underline-offset-2 hover:text-foreground">{children}</a>;
}

export function CompanyWebFacts({ accountId, onPeopleAdded }: { accountId: string; onPeopleAdded?: () => void }) {
  const read = useAction(api.companyWebFacts.forAccount);
  const [state, setState] = useState<WebsiteFactsRead | null>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function load() {
      try {
        const next = await read({ accountId });
        if (!current) return;
        setState(next);
        if (next?.reading) timer = setTimeout(() => void load(), 2_000);
      } catch { if (current) setFailed(true); }
    }
    void load();
    return () => { current = false; clearTimeout(timer); };
  }, [read, accountId]);
  const facts = state?.facts;
  const hasFacts = facts && (facts.linkedinUrl || facts.socials.length || facts.addresses.length || facts.founded || facts.domainRegistered || facts.roleFamilies?.length || facts.physicalOperations?.length || facts.locationCount || facts.openRoles || facts.emails.length || facts.staff?.length);
  return (
    <section aria-label="From their website" className="mt-4 border border-border bg-card p-4">
      <h2 className="mb-2 text-sm font-medium">From their website</h2>
      <CompanyPeople accountId={accountId} websiteReading={state === undefined || Boolean(state?.reading)} onAdded={onPeopleAdded} />
      {state?.discoverySources?.length ? <div className="mb-4 text-sm"><h3 className="font-medium">Where we found this company</h3>{state.discoverySources.map((source, i) => <blockquote key={i} className="mt-2 border-l-2 border-border pl-3 text-muted-foreground"><Source url={source.url}>Source page</Source><p className="mt-1">{source.quote}</p></blockquote>)}</div> : null}
      {failed ? <p className="text-sm text-muted-foreground">We couldn&apos;t load the website facts. Reopen this company to try again.</p>
        : state === undefined || state?.reading ? <p role="status" className="text-sm text-muted-foreground">Reading their public website…</p>
        : !state ? <p className="text-sm text-muted-foreground">No public website is available for this company.</p>
        : !facts ? <p className="text-sm text-muted-foreground">Website facts haven&apos;t been read yet.</p>
        : facts.status === "unreadable" ? <p className="text-sm text-muted-foreground">We couldn&apos;t read this website with a free direct request.</p>
        : facts.status === "error" ? <p className="text-sm text-muted-foreground">The website read failed. We&apos;ll try again when this read expires.</p>
        : <>
          {hasFacts ? <ul className="space-y-2 text-sm text-muted-foreground">
            {facts.linkedinUrl && <li><Source url={facts.linkedinUrl}>LinkedIn company profile</Source></li>}
            {facts.socials.map((url) => <li key={url}><Source url={url}>{new URL(url).hostname.replace(/^www\./, "")}{new URL(url).pathname}</Source></li>)}
            {facts.addresses.map((a) => <li key={a.text}><Source url={a.url}>{a.text}</Source></li>)}
            {facts.founded?.source === "site" && <li><Source url={facts.founded.url}>Founded in {facts.founded.year}</Source>{facts.founded.quote && <span className="ml-2 text-xs">“{facts.founded.quote}”</span>}</li>}
            {facts.emails.map((e) => <li key={e.address}><Source url={e.url}>{e.address}</Source></li>)}
          </ul> : <p className="text-sm text-muted-foreground">We read the website but found no company facts to show.</p>}
          <div className="mt-4">
            <h3 className="text-sm font-medium">Size clues</h3>
            <p className="mt-1 text-xs text-muted-foreground">Clues to the scale of the business. No single clue establishes company headcount.</p>
            <ul className="mt-2 space-y-2 text-sm text-muted-foreground">
              {facts.domainRegistered && <li><Source url={facts.domainRegistered.url}>Domain registered in {facts.domainRegistered.year}</Source> · Clue</li>}
              {facts.founded?.source === "wayback" && <li><Source url={facts.founded.url}>First seen on the web in {facts.founded.year}</Source> · Clue</li>}
              {facts.locationCount && <li><Source url={facts.locationCount.url}>{facts.locationCount.count} locations</Source> · Clue</li>}
              {facts.openRoles && <li><Source url={facts.openRoles.url}>{facts.openRoles.count} open roles</Source> · Clue</li>}
              {facts.roleFamilies?.map((role) => <li key={role.family}><Source url={role.url}>{role.count} listed {role.family} {role.count === 1 ? "role" : "roles"}</Source> · Clue</li>)}
              {facts.physicalOperations?.map((operation, i) => <li key={i}><Source url={operation.url}>Physical operations clue</Source><blockquote className="mt-1 border-l-2 border-border pl-3">“{operation.quote}”</blockquote></li>)}
              {state?.recordSize?.employees !== undefined && <li><Source url={state.recordSize.url}>{state.recordSize.employees.toLocaleString()} employees recorded in your CRM</Source> · Existing record clue</li>}
            </ul>
            {!facts.domainRegistered && facts.founded?.source !== "wayback" && !facts.locationCount && !facts.openRoles && !facts.roleFamilies?.length && !facts.physicalOperations?.length && state?.recordSize?.employees === undefined && <p className="mt-2 text-sm text-muted-foreground">No size clues found in the available sources.</p>}
          </div>
          {facts.staff && <div className="mt-4">
            <h3 className="text-sm font-medium">People named on their website</h3>
            {facts.staff.length ? <ul className="mt-2 space-y-3 text-sm">
              {facts.staff.map((person) => <li key={person.fullName}>
                <p><span className="font-medium">{person.fullName}</span>{person.title && <span className="text-muted-foreground"> · {person.title}</span>}</p>
                <Source url={person.url}>Source page</Source>
                <blockquote className="mt-1 border-l-2 border-border pl-3 text-muted-foreground">{person.quote}</blockquote>
              </li>)}
            </ul> : <p className="mt-1 text-sm text-muted-foreground">No staff names with website evidence were found.</p>}
            {facts.staffModelStatus === "skipped-no-key" && <p className="mt-2 text-xs text-muted-foreground">The additional staff search was skipped because it is not configured.</p>}
            {facts.staffModelStatus === "failed" && <p className="mt-2 text-xs text-muted-foreground">The additional staff search was unavailable. Names from the page&apos;s structured data are shown when verified.</p>}
          </div>}
          <p className="mt-3 text-xs text-muted-foreground">Pages read: {facts.pages.map((p, i) => <span key={p.kind}>{i > 0 && " · "}<Source url={p.url}>{p.kind === "home" ? "Homepage" : p.kind[0].toUpperCase() + p.kind.slice(1)}</Source></span>)}</p>
          <p className="mt-2 text-xs text-muted-foreground">Read {new Date(facts.fetchedAt).toLocaleDateString()} · Public website</p>
        </>}
    </section>
  );
}
