"use client";

import Image from "next/image";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import type { FunctionReturnType } from "convex/server";
import type { api } from "../../../convex/_generated/api";
import type { Evidence } from "../../../convex/lib/startingPlan";
import { labels, valueLabel } from "@/components/icps/icp-viewer";
import {
  cleanResearchSpec,
  specFromIcp,
} from "../../../convex/lib/icpResearchSpec";
import {
  parseQuery,
  specToQuery,
  type Clause,
} from "../../../convex/lib/icpQuery";
import { ArrowUpRight, Check, ChevronLeft, ChevronRight } from "lucide-react";
import Link from "next/link";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { crmHeadline } from "../../../convex/lib/crmFingerprints";
import { personaTitles, shortList } from "./research-scene-model";
import type { ScreenId } from "./research-reveal-state";

export type ResearchSession = NonNullable<
  FunctionReturnType<typeof api.researchSessions.get>
>;

export const plural = (count: number, one: string, many = `${one}s`) =>
  `${count.toLocaleString()} ${count === 1 ? one : many}`;

/** Where a finding came from. With a description, the description is the link; otherwise the page is. */
export function Source({
  url,
  children,
}: {
  url: string;
  children?: React.ReactNode;
}) {
  if (!/^https?:\/\//i.test(url))
    return (
      <span className="research-source">{children ?? "Research record"}</span>
    );
  const parsed = new URL(url);
  const page = `${parsed.hostname.replace(/^www\./, "")}${parsed.pathname.replace(/\/$/, "")}`;
  return (
    <span className="research-source">
      <a href={url} target="_blank" rel="noreferrer" title={page}>
        {children ?? page}
        <ArrowUpRight size={13} aria-hidden />
      </a>
    </span>
  );
}
export function Quote({ evidence }: { evidence: Evidence }) {
  return (
    <figure className="research-quote">
      <blockquote>{evidence.quote}</blockquote>
      <Source url={evidence.url} />
    </figure>
  );
}
/** The one way a missing or unmeasured finding is shown. */
export function Unknown({ children }: { children: React.ReactNode }) {
  return <p className="research-unknown">{children}</p>;
}
/** Chips that fit one row of about `budget` characters; the rest collapse into "+N". */
function Chips({ items, budget }: { items: string[]; budget: number }) {
  let used = 0,
    shown = 0;
  for (const item of items) {
    const next = used + item.length + 4;
    const reserve = shown + 1 < items.length ? 4 : 0;
    if (shown && next + reserve > budget) break;
    used = next;
    shown++;
  }
  const rest = items.slice(shown);
  return (
    <span className="research-chips">
      {items.slice(0, shown).map((item) => (
        <span key={item}>{item}</span>
      ))}
      {rest.length > 0 && (
        <span className="research-chip-more" title={rest.join(", ")}>
          <span aria-hidden>+{rest.length}</span>
          <span className="sr-only">and {rest.join(", ")}</span>
        </span>
      )}
    </span>
  );
}

export function BrandImage({
  name,
  src,
  domain,
  shared = false,
  reduced = false,
}: {
  name: string;
  src?: string;
  domain?: string;
  shared?: boolean;
  reduced?: boolean;
}) {
  const fallback = domain
    ? `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=128`
    : undefined;
  const [failed, setFailed] = useState<string[]>([]);
  const current = [src, fallback].find((url) => url && !failed.includes(url));
  return (
    <motion.span
      layoutId={shared && !reduced ? "company-logo" : undefined}
      className="research-logo"
    >
      {current ? (
        <Image
          unoptimized
          width={64}
          height={64}
          src={current}
          alt={`${name} logo`}
          referrerPolicy="no-referrer"
          className="size-full object-contain"
          onError={() => setFailed((urls) => [...urls, current])}
        />
      ) : (
        <span aria-label={name}>{name.slice(0, 1).toUpperCase()}</span>
      )}
    </motion.span>
  );
}

export function CompanyStage({
  session,
  reduced,
  compact,
}: {
  session: ResearchSession;
  reduced: boolean;
  compact: boolean;
}) {
  const company = session.companyFinding;
  const customers = company?.brand?.customers ?? [];
  const quotes = company?.evidence ?? [];
  return (
    <div className="research-sections">
      <header className="research-identity">
        <BrandImage
          shared
          reduced={reduced}
          name={company?.name ?? session.domain}
          src={company?.brand?.logoUrl}
          domain={session.domain}
        />
        <div>
          <h2 className="research-record">{company?.name ?? session.domain}</h2>
          <p className="research-meta">{session.domain}</p>
        </div>
      </header>
      <section>
        <h3>What you sell</h3>
        <p className="research-lead">
          {session.companySummaryEdit ?? company?.summary ?? session.icp?.name}
        </p>
      </section>
      <section>
        <h3>In your words</h3>
        {quotes.slice(0, compact ? 1 : 2).map((evidence, index) => (
          <Quote key={index} evidence={evidence} />
        ))}
        {!quotes.length && (
          <Unknown>No quote from your site could be verified.</Unknown>
        )}
      </section>
      {customers.length > 0 && (
        <section>
          <h3>Customers on your site</h3>
          <ul className="research-logos">
            {customers.slice(0, compact ? 2 : 4).map((customer) => (
              <li key={customer.name}>
                <BrandImage name={customer.name} src={customer.logoUrl} />
                {customer.name}
              </li>
            ))}
            {customers.length > (compact ? 2 : 4) && (
              <li
                className="research-chip-more"
                title={customers
                  .slice(compact ? 2 : 4)
                  .map((c) => c.name)
                  .join(", ")}
              >
                +{customers.length - (compact ? 2 : 4)}
              </li>
            )}
          </ul>
        </section>
      )}
    </div>
  );
}

export function MarketStage({
  session,
  reduced,
  compact,
}: {
  session: ResearchSession;
  reduced: boolean;
  compact: boolean;
}) {
  const segments = session.segments ?? [];
  const sample = segments.reduce((sum, segment) => sum + segment.count, 0);
  const max = Math.max(1, ...segments.map((segment) => segment.count));
  const shown = compact ? 3 : 5;
  const accounts = (session.preview ?? []).slice(0, compact ? 2 : 6);
  return (
    <div className="research-sections">
      <section>
        <p className="research-figure">
          <motion.span layoutId={reduced ? undefined : "tam-number"}>
            {session.tamTotal?.toLocaleString() ?? "Pending"}
            {session.tamSaturated ? "+" : ""}
          </motion.span>
          <span>
            {session.tamSaturated
              ? "companies or more match your filters"
              : "companies match your filters"}
          </span>
        </p>
        <p className="research-meta">
          Counted in{" "}
          {session.tamSource === "quickenrich"
            ? "QuickEnrich"
            : "the prospect index"}
          {session.tamSaturated ? ", which stopped at its limit" : ""}.
        </p>
      </section>
      <section>
        <h3>
          {segments.length > shown
            ? `Top ${shown} of ${segments.length} segments`
            : "Segments"}{" "}
          in a sample of {plural(sample, "account")}
        </h3>
        <ul className="research-bars">
          {segments.slice(0, shown).map((segment) => (
            <li key={segment.id}>
              <span>{segment.name.replace(" · ", ", ")}</span>
              <strong>{segment.count.toLocaleString()}</strong>
              <span className="research-bar" aria-hidden>
                <span style={{ width: `${(segment.count / max) * 100}%` }} />
              </span>
            </li>
          ))}
        </ul>
        {!segments.length && (
          <Unknown>No segments came back from the sample.</Unknown>
        )}
      </section>
      <section>
        <h3>Best fit in the sample</h3>
        <ul
          className={
            compact
              ? "research-accounts research-accounts--list"
              : "research-accounts"
          }
        >
          {accounts.map((row) => (
            <li key={row.id}>
              <BrandImage name={row.name} domain={row.domain} />
              <span>{row.name}</span>
              <strong>{Math.round(row.fit * 100)}% fit</strong>
            </li>
          ))}
        </ul>
        {accounts.length ? (
          <Unknown>
            Fit is a model score against your filters, not buying intent.
          </Unknown>
        ) : (
          <Unknown>No example accounts came back.</Unknown>
        )}
      </section>
    </div>
  );
}

function ClauseRow({ clause, budget }: { clause: Clause; budget: number }) {
  const values = clause.values ?? [];
  return (
    <div>
      <dt>
        {clause.neg ? "Excluding " : ""}
        {clause.key === "field" ? clause.slug : labels[clause.key]}
      </dt>
      <dd>
        <Chips
          items={values.map((v) => valueLabel(clause.key, v))}
          budget={budget}
        />
      </dd>
    </div>
  );
}
export function BuyersStage({
  session,
  compact,
}: {
  session: ResearchSession;
  compact: boolean;
}) {
  const query = session.icp
    ? parseQuery(
        specToQuery(cleanResearchSpec(specFromIcp(session.icp))),
        "icp",
      ).query
    : null;
  const people = query?.has.find((h) => !h.neg);
  const buyers = session.marketSegments?.buyers ?? [];
  const shownBuyers = compact ? 1 : 2;
  const budget = compact ? 30 : 40;
  return (
    <div className="research-sections">
      <section aria-label="Company target">
        <h3>Companies</h3>
        <dl className="research-facts research-facts--chips">
          {query?.clauses
            .filter((c) => c.key !== "field")
            .map((clause, index) => (
              <ClauseRow key={index} clause={clause} budget={budget} />
            ))}
        </dl>
        {!query && <Unknown>The buyer profile has not arrived.</Unknown>}
      </section>
      {people && (
        <section aria-label="Buyer persona">
          <h3>People</h3>
          <dl className="research-facts research-facts--chips">
            {people.clauses
              .filter(
                (c) =>
                  c.key !== "title" &&
                  // Titles already name the department on small screens.
                  !(
                    compact &&
                    c.key === "dept" &&
                    personaTitles(session).length
                  ),
              )
              .map((clause, index) => (
                <ClauseRow key={index} clause={clause} budget={budget} />
              ))}
            {personaTitles(session).length > 0 && (
              <div>
                <dt>Titles</dt>
                <dd>
                  <Chips items={personaTitles(session)} budget={budget} />
                </dd>
              </div>
            )}
          </dl>
        </section>
      )}
      {buyers.length > 0 && (
        <section>
          <h3>Buyer segments</h3>
          <ul className="research-list">
            {buyers.slice(0, shownBuyers).map((segment) => (
              <li key={segment.archetype}>
                <p className="research-strong">{segment.label}</p>
                <p>{segment.why}</p>
                <p className="research-meta">
                  {segment.estCount !== null
                    ? `About ${plural(segment.estCount, "company", "companies")} in the prospect index`
                    : "Size not measured"}
                </p>
              </li>
            ))}
          </ul>
          {buyers.length > shownBuyers && (
            <p className="research-meta">
              {plural(buyers.length - shownBuyers, "more segment")}:{" "}
              {buyers
                .slice(shownBuyers)
                .map((b) => b.label)
                .join(", ")}
            </p>
          )}
        </section>
      )}
    </div>
  );
}

const MOTION = {
  "sales-led": "Sales-led",
  "self-serve": "Self-serve",
  hybrid: "Self-serve and sales-led",
};
export function TeamStage({
  session,
  compact,
}: {
  session: ResearchSession;
  compact: boolean;
}) {
  const team = session.teamShape;
  const crm = team ? crmHeadline(team) : null;
  const motionValue = team?.motion.value ?? "unknown";
  const motionEvidence = team?.motion.evidence[0];
  const hiring = team?.hiring.value;
  const size = team?.sizeBand.value;
  const modules = session.startingPlan?.modules ?? [];
  return (
    <div className="research-sections">
      <dl className="research-facts">
        <div>
          <dt>CRM</dt>
          <dd>
            {crm ? (
              <>
                <p className="research-strong">
                  {/* Small screens: the links under it already point to the site. */}
                  {compact && !crm.confirmed
                    ? crm.title.replace(/ on your site$/, "")
                    : crm.title}
                </p>
                {crm.confirmed ? (
                  crm.sources.slice(0, compact ? 1 : 3).map((source) => (
                    <Source key={source.label} url={source.url}>
                      {source.label}
                    </Source>
                  ))
                ) : (
                  <>
                    {/* Each tool links to its page; short enough to share one line. */}
                    <span className="research-source-row">
                      {crm.sources.map((source) => (
                        <Source key={source.label} url={source.url}>
                          {source.label}
                        </Source>
                      ))}
                    </span>
                    {!compact && (
                      <Unknown>Which one is your CRM is not confirmed</Unknown>
                    )}
                  </>
                )}
              </>
            ) : (
              <Unknown>No CRM code found on your homepage</Unknown>
            )}
          </dd>
        </div>
        <div>
          <dt>Sales motion</dt>
          <dd>
            {motionValue === "unknown" ? (
              <Unknown>No pricing page found</Unknown>
            ) : (
              <>
                <p className="research-strong">{MOTION[motionValue]}</p>
                {motionEvidence && (
                  <Source url={motionEvidence.url}>
                    “{motionEvidence.quote}” on your{" "}
                    {/pricing/i.test(motionEvidence.url)
                      ? "pricing page"
                      : "site"}
                  </Source>
                )}
              </>
            )}
          </dd>
        </div>
        <div>
          <dt>Open roles</dt>
          <dd>
            {hiring ? (
              <>
                <p className="research-strong">
                  {plural(hiring.sales, "sales role")},{" "}
                  {plural(hiring.cs, "customer role")}
                </p>
                {team?.hiring.evidence[0] && (
                  <Source url={team.hiring.evidence[0].url}>
                    Your public job board
                  </Source>
                )}
              </>
            ) : (
              <Unknown>No public job board found</Unknown>
            )}
          </dd>
        </div>
        <div>
          <dt>Company size</dt>
          <dd>
            {size ? (
              <>
                <p className="research-strong">
                  {size.replace(/(\d)-(\d)/, "$1–$2")}
                </p>
                <span className="research-source">From the prospect index</span>
              </>
            ) : (
              <Unknown>Not in the prospect index</Unknown>
            )}
          </dd>
        </div>
      </dl>
      {modules.length > 0 && (
        <section>
          <h3>Your workspace would start with</h3>
          <Chips
            items={modules.map((module) => module.label)}
            budget={compact ? 48 : 60}
          />
        </section>
      )}
      <Unknown>
        Public signals only, not a view of what your team uses day to day.
      </Unknown>
    </div>
  );
}

export function PositioningStage({
  session,
  compact,
}: {
  session: ResearchSession;
  compact: boolean;
}) {
  const points = session.brief?.positioning ?? [];
  const [angle, ...more] = [
    ...points.filter((p) => p.kind === "recommendation"),
  ];
  const claims = points.filter((p) => p.kind === "claim");
  const alternatives = points.filter((p) => p.kind === "alternative");
  if (!points.length)
    return (
      <div className="research-sections">
        <Unknown>
          {session.briefStatus === "unavailable"
            ? "No positioning brief could be verified against your website. The rest of your research is unaffected."
            : "Checking the positioning brief against its sources."}
        </Unknown>
      </div>
    );
  const shownClaims = compact ? 1 : 2;
  return (
    <div className="research-sections">
      {angle && (
        <section>
          <h3>Angle to test</h3>
          <p className="research-lead">{angle.text}</p>
          {angle.evidence[0] && <Quote evidence={angle.evidence[0]} />}
          {!compact && more[0] && (
            <p className="research-meta">Also worth testing: {more[0].text}</p>
          )}
        </section>
      )}
      <section>
        <h3>What your site claims</h3>
        <ul className="research-list">
          {claims.slice(0, shownClaims).map((claim, index) => (
            <li key={index}>
              <p>{claim.text}</p>
              {claim.evidence[0] &&
                (compact ? (
                  <Source url={claim.evidence[0].url} />
                ) : (
                  <Quote evidence={claim.evidence[0]} />
                ))}
            </li>
          ))}
        </ul>
        {claims.length > shownClaims && (
          <p className="research-meta">
            {plural(claims.length - shownClaims, "more claim")} in your sources
          </p>
        )}
      </section>
      <section>
        <h3>Alternatives</h3>
        {alternatives.length ? (
          <ul className="research-list">
            {alternatives.slice(0, 2).map((alternative, index) => (
              <li key={index}>
                <p>{alternative.text}</p>
                {alternative.evidence[0] && (
                  <Source url={alternative.evidence[0].url} />
                )}
              </li>
            ))}
          </ul>
        ) : (
          <Unknown>
            Your sources name no competitor, so no comparison is asserted.
          </Unknown>
        )}
      </section>
    </div>
  );
}

/** Each stage's shape before its finding arrives. */
const PENDING: Record<Exclude<ScreenId, "waitlist">, string[]> = {
  offer: ["What you sell", "In your words", "Customers on your site"],
  market: [
    "Companies that match",
    "Segments in the sample",
    "Best fit in the sample",
  ],
  buyers: ["Companies", "People", "Buyer segments"],
  team: ["CRM", "Sales motion", "Open roles", "Company size"],
  plan: ["Angle to test", "What your site claims", "Alternatives"],
};
export function PendingStage({
  screen,
  waiting,
}: {
  screen: Exclude<ScreenId, "waitlist">;
  waiting: boolean;
}) {
  return (
    <div className="research-sections research-pending">
      {PENDING[screen].map((label) => (
        <section key={label}>
          <h3>{label}</h3>
          <span className="research-placeholder" />
          <span className="research-placeholder research-placeholder--short" />
        </section>
      ))}
      {waiting && (
        <Unknown>
          Not found yet. This fills in if it arrives; research carries on.
        </Unknown>
      )}
    </div>
  );
}

function TypedEmail({
  body,
  reduced,
  id,
  onOverflow,
}: {
  body: string;
  reduced: boolean;
  id: string;
  onOverflow: (overflowing: boolean) => void;
}) {
  const [length, setLength] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (reduced) return;
    if (sessionStorage.getItem(`draft-read:${id}`)) return;
    const timer = setInterval(
      () =>
        setLength((value) => {
          const next = Math.min(body.length, value + 6);
          if (next === body.length) {
            clearInterval(timer);
            sessionStorage.setItem(`draft-read:${id}`, "1");
          }
          return next;
        }),
      20,
    );
    return () => clearInterval(timer);
  }, [body, reduced, id]);
  const done =
    reduced ||
    (typeof window !== "undefined" &&
      sessionStorage.getItem(`draft-read:${id}`)) ||
    length >= body.length;
  useLayoutEffect(() => {
    const element = box.current;
    if (!element) return;
    const check = () =>
      onOverflow(element.scrollHeight > element.clientHeight + 2);
    check();
    const observer = new ResizeObserver(check);
    observer.observe(element);
    return () => observer.disconnect();
  }, [done, length, onOverflow]);
  return (
    <div className="research-email-body" ref={box}>
      <p className="sr-only">{body}</p>
      <p aria-hidden>{done ? body : body.slice(0, length)}</p>
    </div>
  );
}

export function FinalStage({
  session,
  reduced,
  selected,
  onSelect,
}: {
  session: ResearchSession;
  reduced: boolean;
  selected: number;
  onSelect: (index: number) => void;
}) {
  const drafts = session.brief?.drafts ?? [];
  const draft = drafts[selected];
  const [overflowing, setOverflowing] = useState(false);
  const [reading, setReading] = useState(false);
  const roles = personaTitles(session);
  return (
    <div className="research-final">
      {draft ? (
        <article
          id="research-email-card"
          className="research-email"
          aria-label="Outreach draft"
          data-overflow={overflowing}
        >
          <header>
            <BrandImage
              name={draft.account.name}
              domain={draft.account.domain}
            />
            <div>
              <p className="research-strong">{draft.account.name}</p>
              <p className="research-meta" title={roles.join(", ")}>
                To {shortList(roles, 1)}
              </p>
            </div>
            {drafts.length > 1 && (
              <div
                className="research-draft-switch"
                role="group"
                aria-label="Outreach drafts"
              >
                <button
                  type="button"
                  aria-label="Previous draft"
                  disabled={selected === 0}
                  onClick={() => onSelect(selected - 1)}
                >
                  <ChevronLeft size={16} aria-hidden />
                </button>
                <span aria-live="polite">
                  {selected + 1}/{drafts.length}
                </span>
                <button
                  type="button"
                  aria-label="Next draft"
                  disabled={selected === drafts.length - 1}
                  onClick={() => onSelect(selected + 1)}
                >
                  <ChevronRight size={16} aria-hidden />
                </button>
              </div>
            )}
          </header>
          <p className="research-email-subject">{draft.subject}</p>
          <TypedEmail
            key={selected}
            id={`${session.token}:${selected}`}
            body={draft.body}
            reduced={reduced}
            onOverflow={setOverflowing}
          />
          <footer>
            <button
              type="button"
              className="research-text-button"
              onClick={() => setReading(true)}
            >
              {overflowing ? "Read the full draft" : "Why this angle"}
            </button>
            <span className="research-meta">Draft only. Nothing is sent.</span>
          </footer>
          <Dialog open={reading} onOpenChange={setReading}>
            <DialogContent className="research-draft-dialog">
              <DialogTitle>{draft.subject}</DialogTitle>
              <DialogDescription>
                To {roles.join(", ")} at {draft.account.name}
              </DialogDescription>
              <p className="research-dialog-body">{draft.body}</p>
              <h3>Why this angle</h3>
              <p>{draft.pain}</p>
              <Unknown>
                A question to test with {draft.account.name}, not a claim about
                them.
              </Unknown>
              {session.brief?.positioning[draft.positioningIndex] && (
                <p>{session.brief.positioning[draft.positioningIndex].text}</p>
              )}
              {draft.evidence.slice(0, 2).map((evidence, index) => (
                <Quote key={index} evidence={evidence} />
              ))}
            </DialogContent>
          </Dialog>
        </article>
      ) : (
        <Unknown>
          {session.briefStatus === "pending" || !session.briefStatus
            ? "Drafting a first email from your research. It appears here once its quotes are checked."
            : session.briefStatus === "unavailable"
              ? "No draft could be verified against your sources, so none is shown."
              : "No example account matched a buyer segment, so no draft was written."}
        </Unknown>
      )}
      <WaitlistForm session={session} />
    </div>
  );
}

export function WaitlistForm({ session }: { session: ResearchSession }) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("");
  const [teamSize, setTeamSize] = useState(
    session.teamShape?.sizeBand.value ?? "",
  );
  const [website, setWebsite] = useState("");
  const [status, setStatus] = useState<
    "idle" | "saving" | "saved" | "detailed"
  >("idle");
  const [error, setError] = useState("");
  async function save(details: boolean) {
    setStatus("saving");
    setError("");
    try {
      const response = await fetch("/api/lead-magnet/waitlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token: session.token,
          email,
          role: details ? role : "",
          teamSize,
          website,
        }),
      });
      const result: { error?: string } = await response.json();
      if (!response.ok)
        throw new Error(
          result.error ?? "Could not save your place. Try again.",
        );
      setStatus(details ? "detailed" : "saved");
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not save your place.",
      );
      setStatus(details ? "saved" : "idle");
    }
  }
  if (session.invited)
    return (
      <section className="research-waitlist" aria-label="Your invitation">
        <p>
          Your invitation is ready. Open the workspace to keep this research.
        </p>
        <Link className="research-cta" href={`/start/${session.token}/claim`}>
          Open your workspace
        </Link>
      </section>
    );
  const saved =
    status !== "idle" && status !== "saving" ? true : session.waitlisted;
  return (
    <section className="research-waitlist" aria-label="Join the waitlist">
      {saved ? (
        <div role="status" className="research-confirmation">
          <Check aria-hidden size={18} />
          <div>
            <p className="research-strong">You’re on the waitlist.</p>
            <p>
              We saved this research. We’ll open your workspace with it when we
              let you in.
            </p>
            {status === "saved" && email && (
              <form
                className="research-details"
                onSubmit={(event) => {
                  event.preventDefault();
                  void save(true);
                }}
              >
                <label>
                  Your role
                  <input
                    autoComplete="organization-title"
                    value={role}
                    maxLength={100}
                    onChange={(event) => setRole(event.target.value)}
                  />
                </label>
                <label>
                  Team size
                  <input
                    value={teamSize}
                    maxLength={60}
                    onChange={(event) => setTeamSize(event.target.value)}
                  />
                </label>
                <button type="submit" className="research-text-button">
                  Add details
                </button>
              </form>
            )}
          </div>
        </div>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void save(false);
          }}
        >
          <label htmlFor="waitlist-email">Work email</label>
          <div className="research-email-row">
            <input
              id="waitlist-email"
              type="email"
              required
              autoComplete="email"
              maxLength={254}
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
            <button
              className="research-cta"
              type="submit"
              disabled={status === "saving"}
            >
              {status === "saving" ? "Saving…" : "Join the waitlist"}
            </button>
          </div>
          <input
            className="research-honeypot"
            aria-hidden
            tabIndex={-1}
            autoComplete="off"
            name="website"
            value={website}
            onChange={(event) => setWebsite(event.target.value)}
          />
        </form>
      )}
      {error && (
        <p role="alert" className="research-error-text">
          {error}
        </p>
      )}
    </section>
  );
}

/** The final screen's summary of every stage, with real counts only. */
export function recapItems(session: ResearchSession) {
  const team = session.teamShape;
  const signals = [
    // An unconfirmed CRM still counts: its fingerprints are shown as the finding.
    !!team && !!crmHeadline(team),
    ...[team?.motion, team?.hiring, team?.sizeBand].map(
      (fact) => !!fact?.evidence.length,
    ),
  ].filter(Boolean).length;
  return [
    session.tamTotal != null && {
      value: `${session.tamTotal.toLocaleString()}${session.tamSaturated ? "+" : ""}`,
      label: session.tamTotal === 1 ? "company" : "companies",
    },
    !!session.segments?.length && {
      value: session.segments.length.toLocaleString(),
      label:
        session.segments.length === 1 ? "account segment" : "account segments",
    },
    signals > 0 && {
      value: String(signals),
      label: signals === 1 ? "setup signal" : "setup signals",
    },
    !!session.brief?.positioning.length && {
      value: String(session.brief.positioning.length),
      label:
        session.brief.positioning.length === 1
          ? "positioning point"
          : "positioning points",
    },
  ].filter(Boolean) as Array<{ value: string; label: string }>;
}
export function Recap({ session }: { session: ResearchSession }) {
  const items = recapItems(session);
  if (!items.length) return null;
  return (
    <section className="research-recap" aria-label="Research recap">
      <h3>Saved with your research</h3>
      <dl>
        {items.map((item) => (
          <div key={item.label}>
            <dt>{item.label}</dt>
            <dd>{item.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
