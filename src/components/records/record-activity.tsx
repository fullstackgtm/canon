"use client";

import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { useAction, useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { BODY_MAX, SUBJECT_MAX } from "../../../convex/lib/email/compose";
import { recordTimeline } from "../../../convex/lib/timeline";
import { activityComposerKinds, pageKind } from "../../../recipes/blocks";
import type { Context } from "../../../recipes/conditions";
import { ACTIVITY_LABELS, activityComposerOffers, activityKind, activityOwner, activityTimeline, type ActivityItem } from "../../../recipes/recordActivity";
import { LogActivity, optionLabel } from "@/components/crm/log-activity";
import { useActivities, useCompanyPeople } from "@/components/crm/signals-ui";
import { useScopedQuery } from "@/lib/use-scoped-query";
import { toast } from "@/lib/toast";
import { getErrorMessage } from "@/lib/utils";
import { SelectField } from "@/components/ui/select";
import { RecordLink, useRecordDraft } from "./record-context";
import { btn } from "./record-parts";
import { RecordSummary } from "./record-summary";
import type { SectionOf } from "./page-sections";
import type { TeamMember } from "./fields";

type Mailbox = NonNullable<NonNullable<ReturnType<typeof useMailboxes>>["accounts"]>[number];
const useMailboxes = (enabled: boolean) => useQuery(api.emailAccounts.mine, enabled ? {} : "skip");
const input = "min-w-0 w-full border border-border bg-background px-2 record-field-row record-value";
const ranges = [{ value: "all", label: "All activity" }, { value: "upcoming", label: "Upcoming & overdue" }, { value: "past", label: "Past activity" }];

function EmailDraft({ id, email, accounts, disabled, label, draftKey }: {
  id: string; email: string; accounts: readonly Mailbox[]; disabled: boolean; label: string; draftKey: string;
}) {
  const draft = useAction(api.emailActions.draftToContact);
  const [from, setFrom] = useRecordDraft(`${draftKey}-email-from`, "");
  const [subject, setSubject] = useRecordDraft(`${draftKey}-email-subject`, "");
  const [body, setBody] = useRecordDraft(`${draftKey}-email-body`, "");
  const [saving, setSaving] = useState(false);
  const sender = accounts.find((account) => account._id === from) ?? accounts[0];
  const canSave = sender && !disabled && !saving && subject.trim() && body.trim();
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!canSave) return;
    setSaving(true);
    try {
      const result = await draft({ accountId: sender._id, contactId: id, subject, body });
      setSubject("");
      setBody("");
      toast.success(`Saved to ${result.address} drafts`);
    } catch (cause) {
      toast.error(getErrorMessage(cause));
    } finally {
      setSaving(false);
    }
  }
  return <form onSubmit={submit} className="grid min-w-0 record-field-grid border border-border record-panel-pad">
    <p className="break-words record-value"><span className="record-label">To</span> {email}</p>
    <SelectField aria-label="Draft from" className="w-fit record-value" value={sender?._id ?? ""} onValueChange={setFrom}
      options={accounts.map(({ _id, address }) => ({ value: _id, label: address }))} />
    <input className={input} placeholder="Subject" aria-label="Subject" value={subject} required maxLength={SUBJECT_MAX} onChange={(event) => setSubject(event.target.value)} />
    <textarea className={input} placeholder="Message" aria-label="Message" value={body} required rows={4} maxLength={BODY_MAX} onChange={(event) => setBody(event.target.value)} />
    <button className={`${btn} justify-self-end`} type="submit" disabled={!canSave}>{label}</button>
  </form>;
}

function ActivityEntry({ item }: { item: ActivityItem }) {
  if (item.kind === "email") return <span className="font-medium">{item.event.subject || "(No subject)"}</span>;
  if (item.kind === "module") return <Link href={item.source.href} className="record-link font-medium hover:underline">{item.subject}</Link>;
  const label = ACTIVITY_LABELS[item.kind];
  const title = item.kind === "note" ? item.body : item.kind === "meeting" ? item.title : item.subject;
  return <RecordLink object={item.kind} id={item.id} className="line-clamp-3 record-link font-medium hover:underline">{title || label}</RecordLink>;
}

function activityDetail(item: ActivityItem): string | null {
  if (item.kind === "task" && item.status) return optionLabel("task", "status", item.status);
  if (item.kind === "call" && item.outcome) return optionLabel("call", "outcome", item.outcome);
  if (item.kind === "module") return item.status;
  if (item.kind === "email") {
    const event = item.event;
    return event.kind === "received" || (event.kind === "message" && event.direction === "in") ||
      (event.kind === "logged" && event.direction === "inbound") ? "Received" : "Sent";
  }
  return null;
}

export function RecordActivity({ object, id, companyId, email, team, section, context, draftKey }: {
  object: string; id: string; companyId?: string; email?: string; team?: readonly TeamMember[];
  section: SectionOf<"activity">; context: Context; draftKey: string;
}) {
  const { composer, filter: initialFilter = {}, group = "none", limit = 10 } = section.props;
  const [filter, setFilter] = useState(initialFilter);
  const [visible, setVisible] = useState(limit);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  const me = useQuery(api.users.me);
  const permissions = useQuery(api.permissions.mine);
  const canEdit = context.canEdit === true && Boolean(permissions && !permissions.preview);
  const mail = useMailboxes(object === "contact" && canEdit && Boolean(email) && (composer?.includes("email") ?? true));
  const accounts = mail?.configured ? mail.accounts.filter((account) => account.status === "ok") : [];
  const kind = pageKind(object);
  const offers = activityComposerOffers(kind, composer, section.actions, {
    ...context, canEdit, "contact.email": Boolean(email), "gmail.linked": accounts.length > 0,
  });
  const emailOffer = offers.find((offer) => offer.kind === "email");
  const contacts = useCompanyPeople(object === "account" ? id : object === "deal" ? companyId : undefined);
  const { activities, refresh, moduleActivityUnavailable } = useActivities({ object, id });
  const observations = useScopedQuery(api.observations.forContact, api.observations.forContactScoped, object === "contact" ? { contactId: id } : "skip");
  const items: ActivityItem[] = [
    ...(activities ?? []),
    ...recordTimeline([], observations?.log ?? [], []).filter((item) => item.kind === "email"),
  ];
  const kinds = [...new Set([...activityComposerKinds(kind), ...items.map(activityKind), ...(filter.kinds ?? [])])].sort();
  const groups = activityTimeline(items, filter, group, now, me?._id);
  const count = groups.reduce((sum, { rows }) => sum + rows.length, 0);
  const page = [];
  let remaining = visible;
  for (const { label, rows } of groups) {
    if (remaining <= 0) break;
    if (rows.length) page.push({ label, rows: rows.slice(0, remaining) });
    remaining -= rows.length;
  }
  const kindLabel = (kind: string) => Object.hasOwn(ACTIVITY_LABELS, kind) ? ACTIVITY_LABELS[kind as keyof typeof ACTIVITY_LABELS] : kind;
  const set = (next: typeof filter) => { setFilter(next); setVisible(limit); };

  return <section aria-label={section.title} className="record-panel record-panel-pad grid record-field-grid">
    <h2 className="record-block-heading record-section-title">{section.title}</h2>
    {offers.length > 0 && <LogActivity targets={[{ object, id }, ...(companyId ? [{ object: "account", id: companyId }] : [])]} contacts={contacts}
      composer={{ draftKey, controls: offers.map((offer) => offer.kind === "email" ? { ...offer, label: ACTIVITY_LABELS.email } : offer),
        email: email && emailOffer && <EmailDraft id={id} email={email} accounts={accounts} disabled={emailOffer.disabled} label={emailOffer.label} draftKey={draftKey} /> }}
      onLogged={(save) => { setNow(Date.now()); void refresh(save); }} />}
    <div className="flex flex-wrap items-center record-field-grid" aria-label="Activity filters" role="group">
      <SelectField aria-label="Activity range" value={filter.range ?? "all"} options={ranges} className="record-value"
        onValueChange={(range) => set({ ...filter, range: range as typeof filter.range })} />
      <label className="flex items-center gap-1 record-value">
        <input type="checkbox" checked={filter.mine ?? false} onChange={(event) => set({ ...filter, mine: event.target.checked })} /> Only mine
      </label>
    </div>
    {kinds.length > 0 && <details>
      <RecordSummary className="record-value">Activity types{filter.kinds && ` (${filter.kinds.length})`}</RecordSummary>
      <div className="flex flex-wrap record-field-grid record-field-row">
        <button type="button" className={btn} onClick={() => set({ ...filter, kinds: undefined })}>All types</button>
        {kinds.map((kind) => <label key={kind} className="flex items-center gap-1 record-value">
          <input type="checkbox" checked={filter.kinds?.includes(kind) ?? true} onChange={(event) => {
            const shown = filter.kinds ?? kinds;
            set({ ...filter, kinds: event.target.checked ? [...shown, kind] : shown.filter((value) => value !== kind) });
          }} /> {kindLabel(kind)}
        </label>)}
      </div>
    </details>}
    {moduleActivityUnavailable && <p role="status" className="record-meta">Module activities are unavailable. Open the module to view its records.</p>}
    {!count && <p className="record-meta">{activities ? "No matching activities." : "Loading activities…"}</p>}
    {page.map(({ label, rows }) => (
      <div key={label} className="record-panel-divider-top record-field-row">
        {label && <h3 className="record-section-title">{label}</h3>}
        <ul>
          {rows.map(({ item, at, date }) => {
            const owner = activityOwner(item);
            const details = [kindLabel(activityKind(item)), activityDetail(item), owner && (team?.find((member) => member._id === owner)?.name ?? "A teammate")];
            const when = new Date(at);
            return <li key={item.kind === "email" ? item.key : item.id} className="flex flex-wrap justify-between gap-x-3 record-field-row border-b border-border last:border-b-0">
              <div className="min-w-0 break-words record-value">
                <ActivityEntry item={item} />
                <div className="record-meta">{details.filter(Boolean).join(" · ")}</div>
              </div>
              <time className="record-meta" dateTime={date ?? when.toISOString()}>{date ? when.toLocaleDateString() : when.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}</time>
            </li>;
          })}
        </ul>
      </div>
    ))}
    {count > visible && <button type="button" className={`${btn} justify-self-start`} onClick={() => setVisible(visible + limit)}>Show more</button>}
  </section>;
}
