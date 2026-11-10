"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { RecordLink } from "./record-context";
import { useAction, useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import type { Related, RelatedCompany } from "../../../convex/associations";
import { DEAL_ROLES, ROLE_LABEL, seniorityLabel, type DealRole } from "../../../convex/lib/committee";
import { DealCommittee } from "@/components/crm/deal-committee";
import { toast } from "@/lib/toast";
import { getErrorMessage } from "@/lib/utils";
import { RecordPicker } from "./lookup-field";
import { CRM_NAME, CrmNote, CrmParentNote, CrmRoleNotes } from "./crm-note";
import { FindContactInfo } from "@/components/crm/find-contact-info";
import { AiCell, useContactAiFields, useContactAnswers } from "@/components/research/ai-cell";
import { ContactResearchMenu } from "@/components/research/research-menu";
import { AiFieldDialog } from "@/components/research/ai-field-dialog";
import { SelectField } from "@/components/ui/select";
import { offered, type ActionId, type Context, type Offer, type PageAction } from "../../../recipes";

const linkBtn = "py-1 text-xs text-muted-foreground underline hover:text-foreground disabled:opacity-50 sm:py-0";
const heading = "text-xs font-medium text-muted-foreground";

/** Data a panel loads, reread after every change it makes. */
function useLoaded<T>(load: () => Promise<T>) {
  const [value, setValue] = useState<T | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    load().then((r) => { if (live) setValue(r); }, () => { if (live) setValue(null); });
    return () => { live = false; };
  }, [load]);
  /** Run one change, then reread. The change returns once the register shows it. */
  const run = useCallback(async (change: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    try {
      await change();
      try {
        setValue(await load());
      } catch (cause) {
        void toast.error(getErrorMessage(cause));
        setValue(null);
      }
      if (done) void toast.success(done);
    } catch (cause) {
      void toast.error(getErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  }, [load]);
  return { value, busy, run };
}

type Run = (change: () => Promise<unknown>, done?: string) => Promise<void>;

/** The recipe's actions in a person's or company's related section, and what the page reads (recipes/actions.ts). */
type Placed = { actions: readonly PageAction[]; ctx: Context };
/** The first of `runs` the page offers in its related section, with what it acts on added to the page's reads. */
const offerIn = (object: "account" | "contact", { actions, ctx }: Placed, runs: ActionId, here: Context = {}): Offer | null =>
  offered(actions, "related", [runs], { ...ctx, ...here }, {}, object)[0] ?? null;

function useRelated(object: "account" | "contact", id: string) {
  const read = useAction(api.associations.related);
  const load = useCallback(() => read({ object, id }), [read, object, id]);
  const { value: related, busy, run } = useLoaded(load);
  return { related, busy, run };
}

function Panel({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="min-w-0 border border-border bg-card p-4">
      <div className="mb-2 flex items-center justify-between gap-3">
        <h2 className={heading}>{title}</h2>
        {action}
      </div>
      {/* A related table scrolls inside its panel on a phone rather than widening the page. */}
      <div className="overflow-x-auto">{children}</div>
    </section>
  );
}

/** "Add …": a button that opens a search of one object, and runs `onPick` with the record chosen. Absent when the page leaves it out. */
function AddRecord({ object, offer, disabled, onPick }: { object: "account" | "contact"; offer: Pick<Offer, "label" | "disabled"> | null; disabled: boolean; onPick: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  if (!offer) return null;
  if (!open) return <button type="button" disabled={disabled || offer.disabled} onClick={() => setOpen(true)} className={linkBtn}>{offer.label}</button>;
  return (
    <div className="w-64">
      <RecordPicker object={object} label={`Search ${object === "account" ? "companies" : "people"}`} autoFocus onCancel={() => setOpen(false)} onPick={(p) => { setOpen(false); onPick(p.id); }} />
    </div>
  );
}

const PrimaryBadge = () => <span className="border border-border px-1.5 py-0.5 text-xs font-medium">Primary</span>;

/**
 * The records of the org's own objects that point at this company, person or deal through a lookup field (CP7d): one panel per
 * (object, lookup field), newest first. Nothing renders when no custom object looks up this kind of record.
 */
export function CustomObjectLists({ target, id }: { target: "account" | "contact" | "deal"; id: string }) {
  const objects = useQuery(api.customObjects.list);
  const panels = (objects ?? []).filter((o) => !o.archived).flatMap((o) => o.lookups.filter((l) => l.lookupTo === target).map((l) => ({ object: o, lookup: l })));
  if (!panels.length) return null;
  return <>{panels.map(({ object, lookup }) => <LookupPanel key={`${object.apiName}:${lookup.apiName}`} object={object} lookup={lookup} id={id} />)}</>;
}

function LookupPanel({ object, lookup, id }: { object: { apiName: string; pluralLabel: string }; lookup: { apiName: string; label: string }; id: string }) {
  const list = useAction(api.objects.list);
  const [rows, setRows] = useState<{ id: string; title: string }[] | null>(null);
  const [total, setTotal] = useState(0);
  useEffect(() => {
    let live = true;
    list({ object: object.apiName, filter: [{ field: lookup.apiName, op: "eq", value: id }], sort: { field: "updatedAt", dir: "desc" }, limit: 10 })
      .then((page) => { if (live) { setRows(page.rows.map((r) => ({ id: r.id, title: r.title }))); setTotal(page.total); } }, () => { if (live) setRows([]); });
    return () => { live = false; };
  }, [list, object.apiName, lookup.apiName, id]);
  return (
    <Panel title={`${object.pluralLabel} (${total}) · ${lookup.label}`}>
      {rows === null ? <p className="text-sm text-muted-foreground">Loading…</p> : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">None yet.</p>
      ) : (
        <ul className="divide-y divide-border text-sm">
          {rows.map((r) => <li key={r.id} className="py-2"><RecordLink object={object.apiName} id={r.id} className="underline">{r.title || "Untitled"}</RecordLink></li>)}
        </ul>
      )}
    </Panel>
  );
}

const OUTCOME = { open: "Open", won: "Won", lost: "Lost" } as const;

/** A contact's companies and the deals they are on, with their role on each. */
export function ContactRelations({ contactId, placed }: { contactId: string; placed: Placed }) {
  const { related, busy, run } = useRelated("contact", contactId);
  const deals = related?.object === "contact" ? related.deals : [];
  return (
    <>
      <ContactCompanies contactId={contactId} related={related} busy={busy} run={run} placed={placed} />
      <Panel title={`Deals (${deals.length})`}>
        {related === undefined ? <p className="text-sm text-muted-foreground">Loading…</p> : deals.length === 0 ? (
          <p className="text-sm text-muted-foreground">Not on a deal yet. Add people to a deal from its page.</p>
        ) : (
          <ul className="divide-y divide-border text-sm">
            {deals.map((d) => (
              <li key={d.streamId} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span className="flex items-baseline gap-2">
                  <RecordLink object={"deal"} id={d.streamId} className="underline">{d.name}</RecordLink>
                  <span className="text-xs text-muted-foreground">{d.outcome === "open" ? d.stage ?? "Open" : OUTCOME[d.outcome]}</span>
                </span>
                <span className="border border-border px-1.5 py-0.5 text-xs font-medium">{ROLE_LABEL[d.role]}</span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
      <CustomObjectLists target="contact" id={contactId} />
    </>
  );
}

/** A contact's companies: the primary marked, and the page's add, remove and make primary. */
function ContactCompanies({ contactId, related, busy, run, placed }: { contactId: string; related: Related | null | undefined; busy: boolean; run: Run; placed: Placed }) {
  const link = useAction(api.associations.link);
  const unlink = useAction(api.associations.unlink);
  const makePrimary = useAction(api.associations.makePrimary);
  const takeCrmCompany = useAction(api.associations.useCrmCompany);
  const companies = related?.object === "contact" ? related.companies : [];
  const linkOffer = offerIn("contact", placed, "kernel.link");
  return (
    <Panel
      title={`Companies (${companies.length})`}
      action={<AddRecord object="account" offer={linkOffer} disabled={busy} onPick={(accountId) => void run(() => link({ contactId, accountId }))} />}
    >
      {related === undefined ? <p className="text-sm text-muted-foreground">Loading…</p> : companies.length === 0 ? (
        <p className="text-sm text-muted-foreground">Not linked to a company yet.</p>
      ) : (
        <ul className="divide-y divide-border text-sm">
          {companies.map((c) => {
            const row = { "row.primary": c.primary };
            const primary = offerIn("contact", placed, "kernel.makePrimary", row), remove = offerIn("contact", placed, "kernel.unlink", row);
            return (
              <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span className="flex items-baseline gap-2">
                  <RecordLink object={"account"} id={c.id} className="underline">{c.name}</RecordLink>
                  {c.domain && <span className="text-xs text-muted-foreground">{c.domain}</span>}
                  {c.primary && <PrimaryBadge />}
                </span>
                <span className="flex items-center gap-3">
                  {primary && <button type="button" disabled={busy || primary.disabled} onClick={() => void run(() => makePrimary({ contactId, accountId: c.id }), `${c.name} is now the primary company`)} className={linkBtn}>{primary.label}</button>}
                  {remove && <button type="button" disabled={busy || remove.disabled} onClick={() => void run(() => unlink({ contactId, accountId: c.id }))} className={linkBtn}>{remove.label}</button>}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {linkOffer && related?.object === "contact" && related.crmCompanies.map((c) => {
        const crm = CRM_NAME[c.provider];
        const company = <RecordLink object="account" id={c.company.id} className="underline">{c.company.name}</RecordLink>;
        return (
          <CrmNote key={c.id} action={c.primary ? `Use ${crm}'s primary company` : `Add ${crm}'s company`} take={() => takeCrmCompany({ id: c.id })}
            done={`${c.company.name} now follows ${crm}`} onUsed={() => void run(async () => undefined)}>
            {c.primary
              ? <>{crm} has {company} as this person&apos;s primary company. Canon keeps the primary a person chose here.</>
              : <>{crm} has this person at {company}. Canon keeps them off it, as a person left it.</>}
          </CrmNote>
        );
      })}
    </Panel>
  );
}

function CompanyLink({ company }: { company: RelatedCompany }) {
  return (
    <span className="flex items-baseline gap-2">
      <RecordLink object={"account"} id={company.id} className="underline">{company.name}</RecordLink>
      {company.domain && <span className="text-xs text-muted-foreground">{company.domain}</span>}
    </span>
  );
}

/** A company's people (each marked by whether this is their primary company) and its parent and child companies, with the page's actions. */
export function CompanyRelations({ accountId, placed }: { accountId: string; placed: Placed }) {
  const { related, busy, run } = useRelated("account", accountId);
  const link = useAction(api.associations.link);
  const unlink = useAction(api.associations.unlink);
  const setParent = useAction(api.associations.setParent);
  const account = related?.object === "account" ? related : null;
  const people = account?.people ?? [];
  const offer = (runs: ActionId, here?: Context) => offerIn("account", placed, runs, here);
  const hierarchy = { "parent.exists": Boolean(account?.parent) };
  const setParentOffer = offer("kernel.setParent", hierarchy), removeParent = offer("kernel.removeParent", hierarchy), removeChild = offer("kernel.removeChild");
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] content-start gap-6">
      <Panel
        title={`People (${people.length})`}
        action={<AddRecord object="contact" offer={offer("kernel.link")} disabled={busy} onPick={(contactId) => void run(() => link({ contactId, accountId }))} />}
      >
        {related === undefined ? <p className="text-sm text-muted-foreground">Loading…</p> : people.length === 0 ? (
          <p className="text-sm text-muted-foreground">No people at this company yet.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-xs font-medium text-muted-foreground">
              <tr><th className="py-1">Name</th><th className="py-1">Title</th><th className="py-1">Level</th><th className="py-1">Email</th><th className="py-1">Phone</th><th className="py-1">LinkedIn</th><th className="py-1">Company</th><th /></tr>
            </thead>
            <tbody>
              {people.map((p) => {
                const row = { "row.primary": p.primary, "row.email": Boolean(p.email), "row.phone": Boolean(p.phone) };
                const remove = offer("kernel.unlink", row);
                return (
                <tr key={p.id} className="border-t border-border">
                  <td className="py-2"><RecordLink object={"contact"} id={p.id} className="underline">{p.name}</RecordLink></td>
                  <td className="py-2">{p.title ?? "—"}</td>
                  <td className="py-2">{seniorityLabel(p.title ?? undefined) || "—"}</td>
                  {(["email", "phone"] as const).map((kind) => {
                    // A lookup reads the person's domain from their primary company, so it runs from that company's page.
                    const find = offer(kind === "email" ? "kernel.findEmail" : "kernel.findPhone", row);
                    return (
                      <td key={kind} className="py-2">
                        {p[kind] ?? (find
                          ? <FindContactInfo kind={kind} label={find.label} disabled={find.disabled} accountId={accountId} contactId={p.id} name={p.name} onFound={() => run(async () => undefined)} />
                          : <span className="text-muted-foreground">—</span>)}
                      </td>
                    );
                  })}
                  <td className="py-2">{p.linkedinUrl ? <a href={p.linkedinUrl} target="_blank" rel="noreferrer" className="underline">profile</a> : "—"}</td>
                  <td className="py-2">{p.primary ? <PrimaryBadge /> : <span className="text-xs text-muted-foreground">Also here</span>}</td>
                  <td className="py-2 text-right">{remove && <button type="button" disabled={busy || remove.disabled} onClick={() => void run(() => unlink({ contactId: p.id, accountId }))} className={linkBtn}>{remove.label}</button>}</td>
                </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Panel>
      <Panel
        title="Parent company"
        action={<AddRecord object="account" offer={setParentOffer} disabled={busy} onPick={(parentId) => void run(() => setParent({ accountId, parentId }))} />}
      >
        {account?.parent ? (
          <div className="flex items-center justify-between gap-2 text-sm">
            <CompanyLink company={account.parent} />
            {removeParent && <button type="button" disabled={busy || removeParent.disabled} onClick={() => void run(() => setParent({ accountId, parentId: null }))} className={linkBtn}>{removeParent.label}</button>}
          </div>
        ) : <p className="text-sm text-muted-foreground">No parent company.</p>}
        {setParentOffer && account?.crmParents.map((c) => (
          <CrmParentNote
            key={c.ref}
            accountId={accountId}
            provider={c.provider}
            crmRef={c.ref}
            parent={c.parent ? <RecordLink object="account" id={c.parent.id} className="underline">{c.parent.name}</RecordLink> : null}
            canonHasParent={Boolean(account.parent)}
            onUsed={() => void run(async () => undefined)}
          />
        ))}
      </Panel>
      <Panel
        title={`Child companies (${account?.children.length ?? 0})`}
        action={<AddRecord object="account" offer={offer("kernel.addChild")} disabled={busy} onPick={(childId) => void run(() => setParent({ accountId: childId, parentId: accountId }))} />}
      >
        {account?.children.length ? (
          <ul className="divide-y divide-border text-sm">
            {account.children.map((c) => (
              <li key={c.id} className="flex items-center justify-between gap-2 py-2">
                <CompanyLink company={c} />
                {removeChild && <button type="button" disabled={busy || removeChild.disabled} onClick={() => void run(() => setParent({ accountId: c.id, parentId: null }))} className={linkBtn}>{removeChild.label}</button>}
              </li>
            ))}
          </ul>
        ) : <p className="text-sm text-muted-foreground">No child companies.</p>}
      </Panel>
      <CustomObjectLists target="account" id={accountId} />
    </div>
  );
}

/**
 * A deal's people on its record page: the buying committee by slot, and
 * everyone on the deal with their role, including people with no slot.
 */
export function DealRelations({ streamId }: { streamId: string }) {
  const read = useAction(api.dealCommittee.forDeal);
  const setRole = useAction(api.dealCommittee.setRole);
  const removeFromDeal = useAction(api.dealCommittee.removeFromDeal);
  const load = useCallback(() => read({ streamId }), [read, streamId]);
  const { value: data, busy, run } = useLoaded(load);
  const [fieldOpen, setFieldOpen] = useState(false);
  const fields = useContactAiFields();
  const contactIds = data?.members.map((m) => m.contactId) ?? [];
  const answers = useContactAnswers(contactIds, fields);
  if (!data) return null;
  const onSet = (role: DealRole, contactId: string, reason?: string) => run(() => setRole({ streamId, contactId, role, ...(reason ? { reason } : {}) }));
  const onRemove = (contactId: string) => run(() => removeFromDeal({ streamId, contactId }));
  return (
    <div className="mt-6 grid gap-6">
      <DealCommittee data={data} busy={busy} onSet={onSet} onRemove={onRemove} />
      <Panel
        title={`People (${data.members.length})`}
        action={<div className="flex flex-wrap items-center gap-3">
          {contactIds.length > 0 && <ContactResearchMenu selectedIds={contactIds} />}
          <button type="button" className={linkBtn} onClick={() => setFieldOpen(true)}>Add AI column</button>
          {data.canEdit && <AddRecord object="contact" offer={{ label: "Add person", disabled: false }} disabled={busy} onPick={(contactId) => void onSet("involved", contactId)} />}
        </div>}
      >
        {data.members.length === 0 ? <p className="text-sm text-muted-foreground">No one on this deal yet.</p> : (
          <table className="w-full text-sm">
            <thead className="text-left text-xs font-medium text-muted-foreground">
              <tr><th className="py-1">Name</th><th className="py-1">Title</th><th className="py-1">Role</th>
                {fields.map((f) => <th key={f.slug} className="px-3 py-1" title={f.question}>{f.label}</th>)}
                <th /></tr>
            </thead>
            <tbody>
              {data.members.map((m) => (
                <tr key={m.contactId} className="border-t border-border">
                  <td className="py-2"><RecordLink object={"contact"} id={m.contactId} className="underline">{m.name}</RecordLink></td>
                  <td className="py-2">{m.title ?? "—"}</td>
                  <td className="py-2">
                    {data.canEdit ? (
                      <SelectField aria-label={`Role of ${m.name}`} value={m.role} disabled={busy} onValueChange={(v) => void onSet(v as DealRole, m.contactId)}
                        options={DEAL_ROLES.map((r) => ({ value: r, label: ROLE_LABEL[r] }))} />
                    ) : ROLE_LABEL[m.role]}
                  </td>
                  {fields.map((f) => <td key={f.slug} className="min-w-48 max-w-sm px-3 py-2"><AiCell field={f} answer={answers?.[m.contactId]?.[f.slug]} /></td>)}
                  <td className="py-2 text-right">
                    {data.canEdit && <button type="button" disabled={busy} onClick={() => void onRemove(m.contactId)} className={linkBtn}>Remove</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {data.canEdit && <CrmRoleNotes roles={data.crmRoles} roleLabel={(r) => ROLE_LABEL[r as DealRole]} onUsed={() => void run(async () => undefined)}
          personLink={(id, name) => <RecordLink object="contact" id={id} className="underline">{name}</RecordLink>} />}
      </Panel>
      {fieldOpen && <AiFieldDialog open={fieldOpen} onOpenChange={setFieldOpen} defaultEntityType="contact" />}
      <CustomObjectLists target="deal" id={streamId} />
    </div>
  );
}
