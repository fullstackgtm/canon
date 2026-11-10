"use client";

import { IntegrationGate } from "@/components/integration-gate";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { RecordLink } from "@/components/records/record-context";
import Link from "next/link";
import { useAction, useMutation, useQuery } from "convex/react";
import { Loader2 } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import type { Activity, ActivityObject, TargetObject } from "../../../convex/lib/activities";
import { projectedPast } from "../../../convex/lib/objects/views";
import type { LinkedinEvent } from "../../../convex/lib/signals/observations";
import type { MessageText } from "../../../convex/lib/conversations/store";
import { GROWTH_KINDS, GROWTH_LABEL, type GrowthKind } from "../../../convex/lib/signals/growth";
import { recordTimeline, type CreatedDeal, type FieldChange, type TimelineItem } from "../../../convex/lib/timeline";
import { scoreHistory, type FitAt, type IcpVersion, type ScoreCause } from "../../../convex/lib/scoreHistory";
import { LogActivity, optionLabel, type Save } from "./log-activity";
import { RecordConversations } from "./conversations";
import { offered, type Context, type PageAction } from "../../../recipes";
import { Button } from "@/components/ui/button";
import { formatRelativeTime } from "@/lib/background-activity";
import { useDeadlinePassed } from "@/lib/use-deadline";
import { useScopedQuery } from "@/lib/use-scoped-query";
import { toast } from "@/lib/toast";
import { cn, formatCurrency, getErrorMessage } from "@/lib/utils";

const TONE: Record<string, string> = { burning: "text-orange-600", warm: "text-amber-600", cool: "text-muted-foreground" };
const LABEL: Record<string, string> = { burning: "Burning", warm: "Warm", cool: "Cool" };

/** The account's heat from its recent signals (convex/lib/signals/heat.ts), or a dash when it has none. */
export function HeatBadge({ heat }: { heat?: { score: number; label: string; count: number } }) {
  if (!heat || heat.label === "none") return <span className="text-muted-foreground">—</span>;
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-xs", TONE[heat.label])} title={`${heat.count} recent signal${heat.count === 1 ? "" : "s"}, heat ${heat.score} out of 100`}>
      <span className="w-7 text-right tabular-nums">{heat.score}</span>
      {LABEL[heat.label]}
    </span>
  );
}

/** How many kinds of growth the account shows (convex/lib/signals/growth.ts), named on hover, or a dash for none. */
export function GrowthBadge({ growth }: { growth?: readonly string[] }) {
  if (!growth?.length) return <span className="text-muted-foreground">—</span>;
  const names = growth.map((g) => GROWTH_LABEL[g as GrowthKind] ?? g).join(", ");
  return (
    <span className="inline-flex items-center gap-1.5 text-xs" title={names}>
      <span className="tabular-nums">{growth.length}/{GROWTH_KINDS.length}</span>
      <span className="max-w-[10rem] truncate text-muted-foreground">{names}</span>
    </span>
  );
}

/** Every growth kind, lit when the account shows it. */
function GrowthChips({ growth }: { growth: readonly string[] }) {
  return (
    <div className="mb-3 flex flex-wrap gap-1.5">
      {GROWTH_KINDS.map((kind) => (
        <span key={kind} className={cn("border px-1.5 py-0.5 font-mono text-[11px]", growth.includes(kind) ? "border-foreground/40 text-foreground" : "border-border text-muted-foreground/60 line-through")}>
          {GROWTH_LABEL[kind]}
        </span>
      ))}
    </div>
  );
}

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
};

const triggerLabel = (trigger: string) => trigger
  .replace(/^hiring: /, "Hiring: ").replace(/^reposted: /, "Reposted: ")
  .replace(/^site updated: /, "Website updated ").replace(/^blog: /, "Blog post: ")
  .replace(/^social: (\w+)$/, (_, network: string) => `On ${({ instagram: "Instagram", tiktok: "TikTok", linkedin: "LinkedIn", youtube: "YouTube", x: "X" } as Record<string, string>)[network] ?? network}`);
const clip = (quote: string) => (quote.length > 240 ? `${quote.slice(0, 240)}…` : quote);
const day = (at: number) => new Date(at).toLocaleDateString();

const PAGE = 50;
const shown = (value: string | number | null) => (value === null || value === "" ? "∅" : String(value));

const LINKEDIN_LABEL: Record<Exclude<LinkedinEvent["kind"], "message">, string> = {
  invite_sent: "LinkedIn invite sent", invite_accepted: "LinkedIn invite accepted", message_sent: "LinkedIn message sent", reply_received: "LinkedIn reply received",
};

/** The text of LinkedIn messages and emails conversation intake read, by timeline key, as the reader may see it (observations.forContact). */
const MessageTexts = createContext<Readonly<Record<string, MessageText>>>({});

/** Text longer than this shows its start until the reader opens it. */
const LINE_TEXT_PREVIEW = 600;

/** A line's text: the one it carries, else what intake read when the reader may see it, else whose it is. */
function LineText({ itemKey, text, userName }: { itemKey: string; text: string | undefined; userName: (id: string) => string }) {
  const read = useContext(MessageTexts)[itemKey];
  const [open, setOpen] = useState(false);
  const shown = text || (read && "text" in read ? read.text : undefined);
  const long = Boolean(shown && shown.length > LINE_TEXT_PREVIEW);
  return (
    <>
      {shown && <blockquote className="mt-1 whitespace-pre-wrap border-l-2 border-border pl-3 text-xs text-muted-foreground">{long && !open ? `${shown.slice(0, LINE_TEXT_PREVIEW)}…` : shown}</blockquote>}
      {long && <button type="button" className="mt-1 text-xs underline" onClick={() => setOpen(!open)}>{open ? "Show less" : "Show all"}</button>}
      {!shown && read && "hidden" in read && <div className="text-xs text-muted-foreground">Only {userName(read.ownerUserId)} and roles that read their activity see this message</div>}
    </>
  );
}

function LinkedinLine({ itemKey, event, cadences, userName }: { itemKey: string; event: LinkedinEvent; cadences: Readonly<Record<string, string>>; userName: (id: string) => string }) {
  const text = event.kind === "invite_sent" ? event.note : event.kind === "message_sent" ? event.body : undefined;
  const step = event.kind === "invite_sent" || event.kind === "message_sent" ? ` · step ${event.step + 1}` : "";
  return (
    <>
      <span className="font-medium">{event.kind === "message" ? (event.direction === "out" ? "LinkedIn message sent" : "LinkedIn message received") : LINKEDIN_LABEL[event.kind]}</span>
      {event.kind !== "message" && <span className="ml-2 text-xs text-muted-foreground">{cadences[event.cadenceId] ?? "Cadence"}{step}</span>}
      <LineText itemKey={itemKey} text={text} userName={userName} />
    </>
  );
}

function TimelineEntry({ item, userName, cadences }: { item: TimelineItem; userName: (id: string) => string; cadences: Readonly<Record<string, string>> }) {
  switch (item.kind) {
    case "field_changed":
      return (
        <>
          <span className="font-mono text-xs">{item.field}</span>{" "}
          <span className="text-muted-foreground line-through">{shown(item.from)}</span> → <span>{shown(item.to)}</span>
          <div className="text-xs text-muted-foreground">{userName(item.actorId)}{item.source ? ` · ${item.source}` : ""}</div>
        </>
      );
    case "signal_started":
    case "signal_quote_changed":
      return (
        <>
          <span className="font-medium">{triggerLabel(item.trigger)}</span>
          <span className="ml-2 text-xs text-muted-foreground">{item.kind === "signal_started" ? "signal started" : "quote changed"}</span>
          <blockquote className="mt-1 border-l-2 border-border pl-3 text-xs text-muted-foreground">
            {item.kind === "signal_quote_changed" && <div className="line-through">&ldquo;{clip(item.previousQuote)}&rdquo;</div>}
            &ldquo;{clip(item.quote)}&rdquo;{" "}
            <a href={item.url} target="_blank" rel="noreferrer noopener" className="underline">{hostOf(item.url)}</a>
          </blockquote>
        </>
      );
    case "signal_ended":
      return (
        <>
          <span className="font-medium">{triggerLabel(item.trigger)}</span>
          <span className="ml-2 text-xs text-muted-foreground">signal ended, live since {day(item.startedAt)}</span>
        </>
      );
    case "linkedin":
      return <LinkedinLine itemKey={item.key} event={item.event} cadences={cadences} userName={userName} />;
    case "hot_lead":
      return (
        <>
          <span className="font-medium">Hot lead</span>
          <span className="ml-2 text-xs text-muted-foreground">replied with interest · {item.provider === "explee" ? "Explee" : item.provider === "gmail" ? "Gmail" : item.provider}</span>
          {item.reply && <blockquote className="mt-1 whitespace-pre-wrap border-l-2 border-border pl-3 text-xs text-muted-foreground">{item.reply}</blockquote>}
        </>
      );
    case "email": {
      const got = item.event.kind === "received" ? item.event : null;
      const what = got?.reply === "bounce" ? `${got.hardBounce === false ? "Delivery delayed" : "Bounced"}${got.bounceStatus ? ` (${got.bounceStatus})` : ""}`
        : got?.reply === "auto_reply" ? `Out of office${got.returnOn ? ` until ${day(Date.parse(`${got.returnOn}T12:00:00Z`))}` : ""}`
        : got?.class ? REPLY_CLASS_LABEL[got.class] : null;
      return (
        <>
          <span className="font-medium">{item.event.kind === "received" || (item.event.kind === "logged" && item.event.direction === "inbound") || (item.event.kind === "message" && item.event.direction === "in") ? "Email received" : "Email sent"}: {item.event.subject || "(no subject)"}</span>
          {what && <span className="ml-2 border border-border px-1.5 py-0.5 text-xs">{what}</span>}
          <span className="ml-2 text-xs text-muted-foreground">
            {[item.event.userId && userName(item.event.userId), `from ${item.event.from}`, item.event.to && `to ${item.event.to}`, item.event.kind === "logged" && "logged in HubSpot"].filter(Boolean).join(" · ")}
          </span>
          <LineText itemKey={item.key} text={"body" in item.event ? item.event.body : undefined} userName={userName} />
        </>
      );
    }
    case "deal_created": {
      const { deal } = item;
      const title = `Deal created: ${deal.name}`;
      return (
        <>
          {deal.streamId ? <RecordLink object="deal" id={deal.streamId} className="font-medium hover:underline">{title}</RecordLink> : <span className="font-medium">{title}</span>}
          <span className="ml-2 text-xs text-muted-foreground">{[deal.stage, deal.amount !== null && formatCurrency(deal.amount, deal.currency)].filter(Boolean).join(" · ")}</span>
        </>
      );
    }
    case "note":
      return <ActivityLine item={item} title={clip(item.body)} detail="note" userName={userName} />;
    case "task":
      return <ActivityLine item={item} title={item.subject} detail={["task", item.dueDate && `due ${item.dueDate}`, item.status && optionLabel("task", "status", item.status)].filter(Boolean).join(" · ")} userName={userName} />;
    case "call":
      return <ActivityLine item={item} title={item.subject ?? "Call"} detail={["call", item.outcome && optionLabel("call", "outcome", item.outcome)].filter(Boolean).join(" · ")} userName={userName} />;
    case "meeting":
      return <ActivityLine item={item} title={item.title} detail={`meeting · ${new Date(item.startAt).toLocaleString()}`} userName={userName} />;
    case "module":
      return <ActivityLine item={item} title={item.subject} detail={[item.activityKind, item.dueDate && `due ${item.dueDate}`, item.status].filter(Boolean).join(" · ")} userName={userName} />;
    default: {
      const unhandled: never = item;
      return unhandled;
    }
  }
}

/** A reply's class as the timeline names it (lib/email/replies.ts). */
const REPLY_CLASS_LABEL: Record<string, string> = { interested: "Interested", not_now: "Not now", not_interested: "Not interested", unsubscribe: "Asked to unsubscribe" };

/** The record whose timeline is shown, so an activity can name the other records it was about. */
const TimelineRecord = createContext("");


function ActivityLine({ item, title, detail, userName }: { item: Activity; title: string; detail: string; userName: (id: string) => string }) {
  const here = useContext(TimelineRecord);
  const elsewhere = (item.targets ?? []).filter((t) => t.id !== here);
  return (
    <>
      {item.kind === "module" ? <Link href={item.source.href} className="font-medium hover:underline">{title}</Link> : <RecordLink object={item.kind} id={item.id} className="font-medium hover:underline">{title}</RecordLink>}
      <span className="ml-2 text-xs text-muted-foreground">{detail}</span>
      {elsewhere.length > 0 && (
        <div className="text-xs text-muted-foreground">
          on{" "}
          {elsewhere.map((t, i) => (
            <span key={t.id}>{i > 0 && ", "}<RecordLink object={t.object} id={t.id} className="hover:underline">{t.name}</RecordLink></span>
          ))}
        </div>
      )}
      {item.ownerId && <div className="text-xs text-muted-foreground">{userName(item.ownerId)}</div>}
    </>
  );
}

const CATCH_UP_MS = 10_000;

/** A record's activities. After a save, re-read until the projection shows it, or show what there is after CATCH_UP_MS. */
export function useActivities({ object, id }: { object: TargetObject; id: string }) {
  const load = useAction(api.activityTargets.forRecord);
  const [activities, setActivities] = useState<Activity[] | undefined>(undefined);
  const [moduleActivityUnavailable, setModuleActivityUnavailable] = useState(false);
  const refresh = useCallback(async (save?: Save) => {
    const started = Date.now();
    try {
      for (;;) {
        const page = await load({ object, id });
        if (!save || projectedPast(page.projectedThrough, [save]) || Date.now() - started > CATCH_UP_MS) {
          setModuleActivityUnavailable(page.moduleActivityUnavailable ?? false);
          return setActivities(page.activities);
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    } catch (cause) {
      setActivities([]);
      toast.error(getErrorMessage(cause));
    }
  }, [load, object, id]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  return { activities, refresh, moduleActivityUnavailable };
}

/** How a record page names each kind of activity it logs, or null when the page logs none. */
type LogLabel = ((kind: ActivityObject) => string) | null;

/** The account's field changes, signal events, activities (useActivities) and deal creations, newest first, with the page's control to log an activity. */
export function AccountTimeline({ accountId, domain, stream, contacts, fieldHistory, activities, refresh, moduleActivityUnavailable, userName, log: logLabel, title }: {
  accountId: string;
  domain: string;
  stream?: string;
  contacts: ReadonlyArray<{ id: string; fullName: string }>;
  fieldHistory: readonly FieldChange[];
  activities: Activity[] | undefined;
  moduleActivityUnavailable?: boolean;
  refresh: (save?: Save) => Promise<void>;
  userName: (id: string) => string;
  log: LogLabel;
  title?: string;
}) {
  // A role that sees only some companies or people reads these through their action twins (CP14).
  const log = useScopedQuery(api.signals.log, api.signals.logScoped, { domain });
  // The same query as the Deals section (CompanyDeals), so Convex serves both from one subscription.
  const deals = useQuery(api.deals.forCompany, { companyId: accountId, domain, ...(stream ? { stream } : {}) });
  const desc = useQuery(api.objects.describe, { object: "deal" });
  const created = useMemo((): CreatedDeal[] => {
    const stageField = desc?.fields.find((f) => f.apiName === "stage");
    const stageLabel = (value: string) => (stageField && "options" in stageField ? stageField.options.find((o) => o.value === value)?.label : undefined) ?? value;
    return (deals ?? []).map((d) => ({
      streamId: d.streamId, name: d.name, amount: d.amount, currency: d.currency, createdAt: d.createdAt,
      stage: d.isClosed ? (d.isWon ? "Closed won" : "Closed lost") : d.stage && stageLabel(d.stage),
    }));
  }, [deals, desc]);
  const items = useMemo(() => recordTimeline(fieldHistory, log ?? [], activities ?? [], created), [fieldHistory, log, activities, created]);
  return (
    <WithConversations object="account" id={accountId} activities={activities} userName={userName}>
      <TimelineSection moduleActivityUnavailable={moduleActivityUnavailable} here={accountId} items={items} loaded={Boolean(log && activities && deals)} userName={userName} cadences={{}} title={title}>
        {logLabel && <LogActivity targets={[{ object: "account", id: accountId }]} contacts={contacts} label={logLabel} onLogged={(save) => void refresh(save)} />}
      </TimelineSection>
    </WithConversations>
  );
}

/** The contact's LinkedIn events, hot-lead replies and activities, newest first, with the page's control to log one about the contact and its company. */
export function ContactTimeline({ contactId, accountId, userName, log, title }: { contactId: string; accountId?: string | null; userName: (id: string) => string; log: LogLabel; title?: string }) {
  const data = useScopedQuery(api.observations.forContact, api.observations.forContactScoped, { contactId });
  const { activities, refresh, moduleActivityUnavailable } = useActivities({ object: "contact", id: contactId });
  const items = useMemo(() => recordTimeline([], data?.log ?? [], activities ?? []), [data, activities]);
  return (
    <WithConversations object="contact" id={contactId} activities={activities} userName={userName}>
      <MessageTexts.Provider value={data?.texts ?? {}}>
        <TimelineSection moduleActivityUnavailable={moduleActivityUnavailable} here={contactId} items={items} loaded={Boolean(data && activities)} userName={userName} cadences={data?.cadences ?? {}} title={title}>
          {log && <LogActivity targets={[{ object: "contact", id: contactId }, ...(accountId ? [{ object: "account" as const, id: accountId }] : [])]} label={log} onLogged={(save) => void refresh(save)} />}
        </TimelineSection>
      </MessageTexts.Provider>
    </WithConversations>
  );
}

/** The deal's activities, newest first, with a control to log one about the deal, its company and one of the company's people. */
export function DealTimeline({ dealId, companyId, userName }: { dealId: string; companyId?: string | null; userName: (id: string) => string }) {
  const { activities, refresh, moduleActivityUnavailable } = useActivities({ object: "deal", id: dealId });
  const people = useCompanyPeople(companyId);
  const items = useMemo(() => recordTimeline([], [], activities ?? []), [activities]);
  return (
    <WithConversations object="deal" id={dealId} activities={activities} userName={userName}>
      <TimelineSection moduleActivityUnavailable={moduleActivityUnavailable} here={dealId} items={items} loaded={Boolean(activities)} userName={userName} cadences={{}}>
        <LogActivity targets={[{ object: "deal", id: dealId }, ...(companyId ? [{ object: "account" as const, id: companyId }] : [])]} contacts={people} onLogged={(save) => void refresh(save)} />
      </TimelineSection>
    </WithConversations>
  );
}

/** A record's Conversations section above its timeline, sharing the timeline's read of its calls and meetings. */
function WithConversations({ children, ...record }: Parameters<typeof RecordConversations>[0] & { children: ReactNode }) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] content-start gap-6">
      <RecordConversations {...record} />
      {children}
    </div>
  );
}

/** The lead's activities, newest first, with a control to log one about the lead. A conversion makes them the person's too. */
export function LeadTimeline({ leadId, userName }: { leadId: string; userName: (id: string) => string }) {
  const { activities, refresh, moduleActivityUnavailable } = useActivities({ object: "lead", id: leadId });
  const items = useMemo(() => recordTimeline([], [], activities ?? []), [activities]);
  return (
    <TimelineSection moduleActivityUnavailable={moduleActivityUnavailable} here={leadId} items={items} loaded={Boolean(activities)} userName={userName} cadences={{}}>
      <LogActivity targets={[{ object: "lead", id: leadId }]} onLogged={(save) => void refresh(save)} />
    </TimelineSection>
  );
}

/** The people on a company, for choosing who an activity was with. */
function useCompanyPeople(companyId: string | null | undefined) {
  const related = useAction(api.associations.related);
  const [people, setPeople] = useState<Array<{ id: string; fullName: string }>>([]);
  useEffect(() => {
    if (!companyId) return;
    let live = true;
    related({ object: "account", id: companyId })
      .then((r) => { if (live && r?.object === "account") setPeople(r.people.map((p) => ({ id: p.id, fullName: p.name }))); })
      .catch(() => {});
    return () => { live = false; };
  }, [related, companyId]);
  return people;
}

function TimelineSection({ here, items, loaded, userName, cadences, children, moduleActivityUnavailable, title = "Timeline" }: {
  here: string; items: readonly TimelineItem[]; loaded: boolean; userName: (id: string) => string; cadences: Readonly<Record<string, string>>; children?: ReactNode; title?: string; moduleActivityUnavailable?: boolean;
}) {
  const [limit, setLimit] = useState(PAGE);
  return (
    <TimelineRecord.Provider value={here}>
    <section className="border border-border bg-card p-4">
      <h2 className="mb-2 text-xs font-medium text-muted-foreground">{title}</h2>
      {children}
      {moduleActivityUnavailable && <p role="status" className="mb-2 text-sm text-muted-foreground">Module activities are unavailable. Open the module to view its records.</p>}
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{loaded ? "Nothing yet." : "Loading…"}</p>
      ) : (
        <ul className="space-y-2 text-sm">
          {items.slice(0, limit).map((item, index) => (
            <li key={`${item.kind}-${item.at}-${index}`} className="grid grid-cols-[6rem_1fr] gap-3 border-b border-border pb-2 last:border-b-0">
              <time className="font-mono text-xs text-muted-foreground" title={item.kind === "module" && item.date ? item.date : new Date(item.at).toLocaleString()}>{item.kind === "module" && item.date ? new Date(item.at).toLocaleDateString(undefined, { timeZone: "UTC" }) : day(item.at)}</time>
              <div><TimelineEntry item={item} userName={userName} cadences={cadences} /></div>
            </li>
          ))}
        </ul>
      )}
      {items.length > limit && (
        <Button size="xs" variant="ghost" className="mt-2" onClick={() => setLimit(limit + PAGE)}>Show more</Button>
      )}
    </section>
    </TimelineRecord.Provider>
  );
}

function causeLabel(cause: ScoreCause): string {
  switch (cause.kind) {
    case "weights":
      return cause.from === null ? `weights v${cause.to}` : `weights v${cause.from} → v${cause.to}`;
    case "field":
      return `${cause.field} ${shown(cause.from)} → ${shown(cause.to)}`;
    case "signal_started":
      return `signal started: ${triggerLabel(cause.trigger)}`;
    case "signal_ended":
      return `signal ended: ${triggerLabel(cause.trigger)}`;
    case "first_contact":
      return "first contact";
    default: {
      const unhandled: never = cause;
      return unhandled;
    }
  }
}

const fitLabel = (fit: FitAt) => (fit.known ? `fit ${fit.fit}` : "fit —");

/** Fit and heat now and at each earlier change, named by its cause (convex/lib/scoreHistory.ts). */
export function ScoreHistory({ account, fieldHistory, activities, contactIds, versions, title = "Score history" }: {
  title?: string;
  account: Parameters<typeof scoreHistory>[0]["account"] & { domain: string; fit: number };
  fieldHistory: readonly FieldChange[];
  activities: Activity[] | undefined;
  contactIds: string[];
  versions: IcpVersion[] | null | undefined;
}) {
  const log = useScopedQuery(api.signals.log, api.signals.logScoped, { domain: account.domain });
  const linkedin = useScopedQuery(api.observations.firstLinkedin, api.observations.firstLinkedinScoped, { contactIds });
  const current = useScopedQuery(api.signals.forAccount, api.signals.forAccountScoped, { domain: account.domain });
  const result = useMemo(() => {
    if (!log || !current || !versions || linkedin === undefined || !activities) return null;
    const contacts = [...activities.map((a) => a.at), ...(linkedin?.first == null ? [] : [linkedin.first])];
    const firstContactAt = contacts.length ? Math.min(...contacts) : null;
    return { heat: current.heat.score, points: scoreHistory({ account, history: fieldHistory, log, versions, firstContactAt, heat: current.model }) };
  }, [account, fieldHistory, log, current, versions, linkedin, activities]);
  const row = "grid grid-cols-[5.5rem_9.5rem_1fr] gap-2";
  return (
    <div className="mt-4 border-t border-border pt-3">
      <h3 className="mb-2 text-xs font-medium text-muted-foreground">{title}</h3>
      {!result ? (
        <p className="text-xs text-muted-foreground">Loading…</p>
      ) : (
        <ul className="space-y-1 text-xs">
          <li className={row}><span className="text-muted-foreground">Now</span><span className="font-mono">fit {Math.round(account.fit * 100)} · heat {result.heat}</span></li>
          {result.points.map((p) => (
            <li key={p.at} className={row}>
              <time className="text-muted-foreground" title={new Date(p.at).toLocaleString()}>{day(p.at)}</time>
              <span className="font-mono" title={p.fit.known ? undefined : "Not on record then"}>{fitLabel(p.fit)} · heat {p.heat}</span>
              <span>{p.causes.map(causeLabel).join(", ")}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The record page's "Top signals" panel: what changed at the account lately, each linking the posting it came from. */
export function TopSignals({ domain, title = "Top signals", children }: { domain: string; title?: string; children?: ReactNode }) {
  const data = useScopedQuery(api.signals.forAccount, api.signals.forAccountScoped, { domain });
  return (
    <section className="border border-border bg-card p-4">
      <h2 className="mb-2 text-xs font-medium text-muted-foreground">
        {title}{data?.heat.label !== "none" && data ? <span className="ml-2 normal-case tracking-normal">heat {data.heat.score}</span> : null}
      </h2>
      {children}
      {data && <GrowthChips growth={data.growth} />}
      {!data || data.signals.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {data ? `No signals in the last ${data.windowDays} days. Canon reads the account's public job board (Greenhouse, Lever or Ashby) and its website's sitemap, blog feed and social links.` : "Loading…"}
        </p>
      ) : (
        <ul className="space-y-3 text-sm">
          {data.signals.map((s) => (
            <li key={s.id}>
              <div className="font-medium">{triggerLabel(s.trigger)}</div>
              <blockquote className="mt-1 border-l-2 border-border pl-3 text-xs text-muted-foreground">
                &ldquo;{clip(s.quote)}&rdquo;{" "}
                <a href={s.sourceUrl} target="_blank" rel="noreferrer noopener" className="underline">{hostOf(s.sourceUrl)}</a>
                <span className="ml-2">{new Date(s.observedAt).toLocaleDateString()}</span>
              </blockquote>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * Where the workspace's signal check stands: last run, next run, accounts checked, with the page's actions to check
 * now or switch the daily check (an admin or manager's).
 */
function SignalsStatusEnabled({ actions, ctx }: { actions: readonly PageAction[]; ctx: Context }) {
  const status = useQuery(api.signals.status);
  const checkNow = useMutation(api.signals.checkNow);
  const setEnabled = useMutation(api.signals.setEnabled);
  // A run that stops reporting is shown as stalled once stallMs passes, even on a page left open.
  const stalled = useDeadlinePassed(status?.run?.status === "running" ? status.run.updatedAt + status.stallMs : null);
  if (!status) return null;
  const run = status.run && stalled ? { ...status.run, status: "failed" as const, error: "The check stopped reporting." } : status.run;
  const running = run?.status === "running";
  const act = (fn: () => Promise<unknown>) => fn().catch((cause) => toast.error(getErrorMessage(cause)));
  const here = { ...ctx, "signals.canManage": status.canManage, "signals.enabled": status.enabled, "signals.running": running };
  const offers = offered(actions, "topSignals", ["kernel.checkSignals", "kernel.toggleSignals"], here, {}, "account");
  return (
    <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-2 border border-border bg-card px-4 py-3 text-xs text-muted-foreground">
      <span className=" ">Signals</span>
      {running && <span className="inline-flex items-center gap-1.5"><Loader2 className="h-3 w-3 animate-spin" /> Checking job boards and websites… {run.checked} of {status.maxAccounts} accounts</span>}
      {run && !running && (
        <span>
          {run.status === "failed" ? `Last check failed (${run.error ?? "unknown error"})` : `Last check ${formatRelativeTime(run.updatedAt)}`}
          {" · "}{run.checked} accounts checked, {run.withBoard} with a job board, {run.newSignals} new signal{run.newSignals === 1 ? "" : "s"}
        </span>
      )}
      {!run && <span>Not checked yet.</span>}
      <span>{status.enabled && status.nextRunAt ? `Next check ${formatNext(status.nextRunAt)}` : "Daily check is off"}</span>
      {offers.length > 0 && (
        <span className="ml-auto flex gap-2">
          {offers.map((o) => o.action.runs === "kernel.checkSignals" ? (
            <Button key={o.action.id} size="xs" variant="outline" disabled={o.disabled} onClick={() => act(async () => { if (!(await checkNow({}))) toast.error("A check is already running."); })}>{o.label}</Button>
          ) : (
            <Button key={o.action.id} size="xs" variant="ghost" disabled={o.disabled} onClick={() => act(() => setEnabled({ enabled: !status.enabled }))}>{o.label}</Button>
          ))}
        </span>
      )}
    </div>
  );
}

function formatNext(at: number) {
  const hours = Math.max(0, Math.round((at - Date.now()) / 3_600_000));
  return hours < 1 ? "within the hour" : hours < 48 ? `in about ${hours} h` : `in ${Math.round(hours / 24)} d`;
}

export function SignalsStatus(props: React.ComponentProps<typeof SignalsStatusEnabled>) {
  return <IntegrationGate feature="treg"><SignalsStatusEnabled {...props} /></IntegrationGate>;
}
