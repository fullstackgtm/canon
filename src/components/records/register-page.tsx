"use client";

/**
 * An account's or a contact's page, laid out by the workspace's account.page or contact.page recipe (docs/recipes.md,
 * "Record pages"): its sections in the recipe's order, each drawn by its kernel component, with the recipe's actions.
 * An edit goes through records.edit, which puts a row nobody has worked onto the ledger first, and returns once the
 * row shows it. History exists once the row is on the ledger.
 */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ModulePanels } from "../modules/module-panels";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAction, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { Archive, ExternalLink, Undo2 } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import type { RegisterListRow } from "../../../convex/lib/objects/listSpec";
import type { AccountStatus, GetResponse } from "../../../convex/lib/recordContract";
import { explainFit, explainGates } from "../../../convex/lib/fitExplain";
import { groupOf } from "../../../convex/lib/canon/personHold";
import { LoadingCards, ReadFailure } from "@/components/dashboard";
import { FitBar, StatusSelect, WhyThisFit } from "@/components/crm/crm-ui";
import { AccountTimeline, ContactTimeline, ScoreHistory, SignalsStatus, TopSignals, useActivities } from "@/components/crm/signals-ui";
import { CompanyDeals } from "@/components/crm/company-deals";
import { CompanyWebFacts } from "@/components/crm/company-web-facts";
import { PeopleAcrossDeals } from "@/components/crm/people-across-deals";
import { CallContact } from "@/components/crm/call-contact";
import { ComposeEmail } from "@/components/crm/compose-email";
import { FindContactInfo } from "@/components/crm/find-contact-info";
import { AiFieldsPanel, useContactAiFields, useContactAnswers } from "@/components/research/ai-cell";
import { KIND_LABEL } from "@/components/crm/log-activity";
import type { ActivityObject } from "../../../convex/lib/activities";
import { SelectField } from "@/components/ui/select";
import { toast } from "@/lib/toast";
import { getErrorMessage } from "@/lib/utils";
import { useScopedQuery } from "@/lib/use-scoped-query";
import { groupFields, offered, sectionActions, type ActionId, type ComponentOf, type Context, type PageSection, type PageSpec } from "../../../recipes";
import { fieldPatch, hasOwnRow, InlineField, primaryListOf, type CellValue, type FieldDescription, type ObjectDescription, type TeamMember } from "./fields";
import { LookupField } from "./lookup-field";
import { CRM_NAME, CrmFieldNote } from "./crm-note";
import { MergeWith } from "./merge-dialog";
import { PageSections, type Renderers } from "./page-sections";
import { CompanyRelations, ContactRelations } from "./related-lists";
import { FieldGroups, Frame, History, btn, type InDialog } from "./record-parts";
import { useRecordInspection } from "./record-context";
import { recordHref, recordListOf } from "./record-target";
import { RunRule } from "./run-rule";

type Party = "account" | "contact";

/** A field's value on the row, by api name. */
function valueOf(fields: readonly FieldDescription[], values: Readonly<Record<string, unknown>>, apiName: string): unknown {
  const field = fields.find((f) => f.apiName === apiName);
  return field ? values[field.fieldId] : undefined;
}

/** The contact's phone number, when it has one. */
function phoneOf(fields: readonly FieldDescription[], values: Readonly<Record<string, unknown>>): string | null {
  const value = valueOf(fields, values, "phone");
  return typeof value === "string" && /\d/.test(value) ? value.trim() : null;
}

/** The contact's email address, when it has one. */
function emailOf(fields: readonly FieldDescription[], values: Readonly<Record<string, unknown>>): string | null {
  const value = valueOf(fields, values, "email");
  return typeof value === "string" && value.includes("@") ? value : null;
}

/** What every section of the page is drawn from: the row, its object's fields and what the person may do. */
type Page = {
  object: Party; id: string; desc: ObjectDescription; row: RegisterListRow; deleted: boolean; team: TeamMember[] | undefined; seesSome: boolean;
  ctx: Context; page: PageSpec; refresh: () => Promise<void>; inDialog?: InDialog;
  saveField: (field: FieldDescription, value: CellValue, startedAt?: number) => Promise<boolean>;
  /** What a CRM says about the record's fields where a person's value held (lib/canon/personHold.ts), and the fields that always follow a CRM. */
  crm: { claims: FunctionReturnType<typeof api.fieldClaims.forRecord> | undefined; follows: FunctionReturnType<typeof api.crmDisagreements.follows> | undefined };
};

/** `preview` lays the page out from a recipe draft instead of the recipe in force (the recipe editor's preview). */
export function RegisterRecordPage({ object, id, inDialog, layout: preview }: { object: Party; id: string; inDialog?: InDialog; layout?: PageSpec }) {
  const desc = useQuery(api.objects.describe, { object });
  const inForce = useQuery(api.recipes.recordPage, preview ? "skip" : { object });
  const layout = preview ? { sections: preview } : inForce;
  const team = useQuery(api.users.list) as TeamMember[] | undefined;
  // A role that sees only some of these records reads their history through the action that admits them (CP14).
  const perms = useQuery(api.permissions.mine);
  const seesSome = Boolean(perms && perms.objects[object]?.visibility !== "all");
  const list = useAction(api.objects.list);
  const edit = useAction(api.records.edit);
  const [row, setRow] = useState<RegisterListRow | null | undefined>(undefined);
  // A row in the recycle bin: shown read-only, with Restore, instead of as missing.
  const [deleted, setDeleted] = useState(false);
  const [generation, setGeneration] = useState(0);
  const [readError, setReadError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const claims = useQuery(api.fieldClaims.forRecord, row?.stream ? { streamId: row.stream as Id<"canonEntities"> } : "skip");
  const follows = useQuery(api.crmDisagreements.follows, {});

  /** The row, live or else from the recycle bin, and whether it was binned. */
  const readRow = useCallback(async (): Promise<{ row: RegisterListRow | null; binned: boolean }> => {
    const filter = [{ field: "id", op: "eq" as const, value: id }];
    const live = ((await list({ object, filter, limit: 1 })).rows[0] as RegisterListRow | undefined) ?? null;
    if (live) return { row: live, binned: false };
    const binned = ((await list({ object, filter, limit: 1, deleted: true })).rows[0] as RegisterListRow | undefined) ?? null;
    return { row: binned, binned: binned !== null };
  }, [list, object, id]);
  const show = (read: { row: RegisterListRow | null; binned: boolean }) => {
    setRow(read.row);
    setDeleted(read.binned);
    setReadError("");
  };
  useEffect(() => {
    let current = true;
    void readRow().then((read) => {
      if (current) {
        setRow(read.row);
        setDeleted(read.binned);
        setReadError("");
      }
    }).catch((cause) => { if (current) setReadError(getErrorMessage(cause)); });
    return () => {
      current = false;
    };
  }, [readRow, attempt]);

  if (readError && row === undefined) return <div className="p-4 sm:p-8"><ReadFailure message={readError} retry={() => { setReadError(""); setAttempt((n) => n + 1); }} /></div>;
  if (desc === undefined || row === undefined || layout === undefined) return <div className="p-4 sm:p-8"><LoadingCards /></div>;
  if (desc === null || row === null || layout === null) {
    return (
      <div className="p-4 sm:p-8">
        <p className="text-sm text-muted-foreground">This record doesn&apos;t exist in this workspace.</p>
        <Link href={recordListOf(object, "").href} className="mt-4 inline-block text-sm underline">Back to the list</Link>
      </div>
    );
  }
  const fields = (desc as ObjectDescription).fields;

  // A merge or its undo changes the related lists and timeline too: they remount and read again.
  async function refresh() {
    show(await readRow());
    setGeneration((g) => g + 1);
    inDialog?.onSaved([]);
  }
  async function saveField(field: FieldDescription, value: CellValue, startedAt?: number): Promise<boolean> {
    try {
      if (startedAt !== undefined) {
        const fresh = await readRow();
        if (fresh.row?.version !== startedAt) {
          show(fresh);
          void toast.error(`${field.label} wasn't saved: this record changed since you started editing. Press Escape to see the current value, then edit again.`);
          return false;
        }
      }
      const patch: Record<string, string | number | boolean | null | string[]> = {};
      for (const [name, next] of Object.entries(fieldPatch(object, field, value))) {
        if (next !== null && typeof next === "object") {
          if (!next.every((v): v is string => typeof v === "string")) throw new Error("Credit splits belong to deals");
          patch[name] = next;
        } else patch[name] = next;
      }
      await edit({ object, id, patch, idempotencyKey: crypto.randomUUID() });
      // records.edit returns once the row shows the edit (and, for a row promoted by it, its stream).
      show(await readRow());
      inDialog?.onSaved([]);
      return true;
    } catch (cause) {
      void toast.error(getErrorMessage(cause));
      return false;
    }
  }

  const ctx: Context = {
    canEdit: desc.writable && !deleted, canDelete: desc.canDelete, deleted,
    "contact.email": Boolean(emailOf(fields, row.values)), "contact.phone": Boolean(phoneOf(fields, row.values)), "contact.company": Boolean(row.accountId),
  };
  const page: Page = { object, id, desc, row, deleted, team, seesSome, ctx, page: layout.sections, refresh, inDialog, saveField, crm: { claims, follows } };
  return (
    <Frame object={object} id={id} plural={desc.pluralLabel} inDialog={inDialog}>
      {readError && <ReadFailure message={readError} retry={() => { setReadError(""); setAttempt((n) => n + 1); }} retained />}
      <ModulePanels revision={`${generation}:${row.version}`} page={object === "account" ? "company" : "person"} record={id} enabled={!inDialog}
        fallback={(kind) => {
          const original = { ...page, page: page.page.filter((s) => s.component === kind) };
          return original.page.length ? (object === "account" ? <AccountSections {...original} /> : <ContactSections {...original} />) : undefined;
        }}
        renderSections={(replaced) => {
          const visible = { ...page, page: page.page.filter((s) => !replaced.has(s.component)) };
          return <div key={generation}>{object === "account" ? <AccountSections {...visible} /> : <ContactSections {...visible} />}</div>;
        }} />
      {object === "account" && !deleted && <CompanyWebFacts key={`${id}:${String(valueOf(fields, row.values, "domain") ?? "")}`} accountId={id} onPeopleAdded={refresh} />}
    </Frame>
  );
}

/** The first action the page offers for `runs` in `host`, or null when the recipe leaves it out. */
const offerOf = (p: Page, section: PageSection, host: "header" | "fields", runs: ActionId, here: Context = {}) =>
  offered(sectionActions(section), host, [runs], { ...p.ctx, ...here }, {}, p.object)[0] ?? null;

const userName = (team: TeamMember[] | undefined) => (uid: string) => team?.find((u) => u._id === uid)?.name ?? "A teammate";
/** How a timeline names each kind of activity it logs, from the recipe's logActivity, or null when it logs none. */
function logLabel(p: Page, section: PageSection) {
  const action = sectionActions(section).find((a) => a.runs === "kernel.logActivity");
  // A timeline has nothing to show for a disabled log button, so a recipe's false `enabled` hides it.
  const offer = action && offered([action], "timeline", [action.runs], p.ctx, {}, p.object)[0];
  if (!action || !offer || offer.disabled) return null;
  return (kind: ActivityObject) => offered([action], "timeline", [action.runs], p.ctx, { kind: KIND_LABEL[kind] }, p.object)[0]?.label ?? KIND_LABEL[kind];
}

/** The sections an account's page and a contact's page draw the same way. */
function partyRenderers(p: Page, title: { aside?: ReactNode; extra?: ReactNode }): Pick<Renderers<ComponentOf<Party>>, "header" | "fields" | "history"> {
  const { object, id, desc, row, deleted, team } = p;
  const fields = desc.fields;
  // A hidden custom field stays out of Details; its history still reads its label. A person's other emails and phones are edited on their primary's row.
  const shownFields = fields.filter((f) => !f.hidden && hasOwnRow(object, f));
  const groups = groupFields(p.page, shownFields).filter((g) => g.fields.length > 0);
  const lastFields = groups.at(-1)?.section;
  return {
    header: (section, { held }) => {
      const offer = (runs: ActionId) => offerOf(p, section, "header", runs);
      const status = offer("kernel.setStatus"), owner = offer("kernel.setOwner"), merge = offer("kernel.merge"), restore = offer("kernel.restore"), archive = offer("kernel.archive");
      const statusField = fields.find((f) => f.apiName === "status"), ownerField = fields.find((f) => f.apiName === "ownerId");
      const lookupAccountId = object === "contact" && row.accountId ? row.accountId : undefined;
      const controls = sectionActions(section).flatMap((a): ReactNode[] => {
        const placed = (o: typeof status) => o?.action.id === a.id;
        if (placed(status) && statusField) {
          return [<StatusSelect key={a.id} label={status!.label} disabled={status!.disabled} value={(valueOf(fields, row.values, "status") as AccountStatus | undefined) ?? "new"} onChange={(next) => void p.saveField(statusField, next)} />];
        }
        if (placed(owner) && ownerField) {
          return [<SelectField key={a.id} aria-label={owner!.label} disabled={owner!.disabled} value={(valueOf(fields, row.values, "ownerId") as string | undefined) ?? ""}
            onValueChange={(v) => void p.saveField(ownerField, v || null)}
            options={[{ value: "", label: "Unassigned" }, ...(team ?? []).filter((u) => u.isActive).map((u) => ({ value: u._id, label: u.name }))]} />];
        }
        if ((a.runs === "kernel.findEmail" || a.runs === "kernel.findPhone") && lookupAccountId) {
          const find = offered([a], "header", [a.runs], p.ctx, {}, object)[0];
          const kind = a.runs === "kernel.findEmail" ? "email" : "phone";
          return find ? [<FindContactInfo key={a.id} kind={kind} label={find.label} disabled={find.disabled} accountId={lookupAccountId} contactId={id} name={row.title || "this person"} className="py-1.5" onFound={p.refresh} />] : [];
        }
        if (placed(restore)) return [<ArchiveButton key={a.id} page={p} archived={false} label={restore!.label} disabled={restore!.disabled} />];
        if (placed(archive)) return [<ArchiveButton key={a.id} page={p} archived label={archive!.label} disabled={archive!.disabled} />];
        if (placed(merge)) return [<MergeButton key={a.id} page={p} label={merge!.label} disabled={merge!.disabled} />];
        return [];
      });
      return (
        <div className="record-header">
          <div>
            <div className="text-xs font-medium text-muted-foreground">{desc.label}</div>
            <h1 className="font-display text-3xl font-semibold">{row.title || "Untitled"}</h1>
            {title.aside}
            {deleted && <p className="mt-1 text-sm text-destructive">Archived. Restore it to edit.</p>}
          </div>
          <div className="record-header-actions">{held}{controls}<RunRule object={object} id={id} /></div>
        </div>
      );
    },
    fields: (section) => {
      const group = groups.find((g) => g.section === section);
      if (!group) return null;
      const edit = offerOf(p, section, "fields", "kernel.editField");
      const readOnly = (f: FieldDescription) => !edit || edit.disabled || desc.readOnlyFields.includes(f.apiName);
      const followedBy = (f: FieldDescription) => p.crm.follows?.filter((x) => x.object === object && x.field === groupOf(object, f.apiName)).map((x) => CRM_NAME[x.provider]) ?? [];
      const field = (f: FieldDescription) => (
        <div key={f.fieldId} className="grid grid-cols-[minmax(6rem,10rem)_minmax(0,1fr)] items-center gap-3 border-b border-border py-1.5 last:border-b-0 [&>*]:min-w-0 [&>*]:break-words">
          <dt className="text-xs font-medium text-muted-foreground">
            {f.label}
            {followedBy(f).length > 0 && <span className="mt-0.5 block text-[10px]" title="An admin set this field to always follow the CRM">Follows {followedBy(f).join(" and ")}: an edit here lasts until its next sync</span>}
          </dt>
          <dd>
            {f.apiName === "updatedAt" ? (
              <span className="block px-2 py-1 text-sm">{new Date(row.updatedAt).toLocaleString()}</span>
            ) : f.type === "lookup" ? (
              <LookupField field={f} value={row.values[f.fieldId] as CellValue | undefined} version={row.version} readOnly={readOnly(f)} onSave={(next, startedAt) => p.saveField(f, next, startedAt)} />
            ) : (
              <InlineField {...(primaryListOf(object, f, row.values) ?? { field: f, value: row.values[f.fieldId] as CellValue | undefined })} version={row.version} team={team} readOnly={readOnly(f)} onSave={(next, startedAt) => p.saveField(f, next, startedAt)} />
            )}
            {p.crm.claims?.filter((c) => c.field === f.fieldId).map((c) => (
              <CrmFieldNote key={c.id} claim={c} canTake={!readOnly(f)} fields={fields} team={team} noun={object === "account" ? "company" : "person"} onUsed={() => void p.refresh()} />
            ))}
          </dd>
        </div>
      );
      return <><FieldGroups groups={[{ title: section.title, collapsed: Boolean(section.collapsed), fields: group.fields }]} field={field} />{section === lastFields && title.extra}</>;
    },
    history: (section) => row.stream ? (
      <History streamId={row.stream as Id<"canonEntities">} fields={fields} team={team} onUndone={() => void p.refresh()} scoped={p.seesSome} refresh={row} title={section.title} />
    ) : (
      <section className="border border-border bg-card p-4">
        <h2 className="mb-2 text-xs font-medium text-muted-foreground">{section.title ?? "History"}</h2>
        <p className="text-sm text-muted-foreground">No changes yet.</p>
      </section>
    ),
  };
}

/** Archive the record, or restore it. An archived record leaves lists, search, reports and agents; the toast's Undo brings it back. */
function ArchiveButton({ page: p, archived, label, disabled }: { page: Page; archived: boolean; label: string; disabled: boolean }) {
  const bulk = useAction(api.records.bulkRegister);
  const [busy, setBusy] = useState(false);
  async function setArchived(to: boolean) {
    setBusy(true);
    try {
      const out = await bulk({ object: p.object, op: to ? "delete" : "restore", ids: [p.id], batchKey: crypto.randomUUID() });
      const problem = out.results[0]?.result.errors?.[0]?.message;
      if (problem) void toast.error(problem);
      else if (to) void toast.success("Archived", { action: { label: "Undo", onClick: () => void setArchived(false) } });
      else void toast.success("Restored");
      await p.refresh();
    } catch (cause) {
      void toast.error(getErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  const Icon = archived ? Archive : Undo2;
  return <button type="button" disabled={busy || disabled} onClick={() => void setArchived(archived)} className={btn}><Icon className="h-3 w-3" /> {label}</button>;
}

function MergeButton({ page: p, label, disabled }: { page: Page; label: string; disabled: boolean }) {
  const router = useRouter();
  const inspection = useRecordInspection();
  function onMerged(survivorId: string) {
    if (survivorId === p.id) void p.refresh();
    else if (p.inDialog && inspection) {
      p.inDialog.onSaved([]);
      inspection.open({ object: p.object, id: survivorId });
    } else router.push(recordHref(p.object, survivorId));
  }
  return <MergeWith object={p.object} id={p.id} title={p.row.title || p.id} label={label} disabled={disabled} onMerged={onMerged} />;
}

/** A company's own reads past its row: its fit, contacts and field history, its activities, and the ICP that scored it. */
/** The company's own snapshot (fit, score history, citations). `row` is the page's row: an edit replaces it, so the snapshot reads again. */
function useCompany(id: string, live: boolean, row: unknown) {
  const get = useAction(api.records.get);
  const [data, setData] = useState<GetResponse | null | undefined>(undefined);
  const { activities, refresh, moduleActivityUnavailable } = useActivities({ object: "account", id });
  const versions = useQuery(api.icpVersions.list);
  const icps = useQuery(api.icpsInterface.list)?.icps;
  const citations = useScopedQuery(api.canonEntities.fitCitations, api.canonEntities.fitCitationsScoped, { recordId: id });
  useEffect(() => {
    if (!live) return;
    let on = true;
    get({ id }).then((r) => { if (on) setData(r); }, () => { if (on) setData(null); });
    return () => { on = false; };
  }, [get, id, live, row]);
  const active = versions?.at(-1);
  const icpName = (icpId: string) => icps?.find((i) => i.key === icpId)?.name ?? "an ICP";
  const account = data?.account;
  const explanation = account && active ? (active.gates ? explainGates(account, active.gates, account.fit, icpName) : explainFit(account, active.weights, account.fit)) : null;
  return { data, activities, refresh, moduleActivityUnavailable, versions, citations, explanation };
}

function AccountSections(p: Page) {
  const { id, row, team } = p;
  const company = useCompany(id, !p.deleted, row);
  const { data, explanation } = company;
  const domain = valueOf(p.desc.fields, row.values, "domain");
  const shared = partyRenderers(p, {
    aside: typeof domain === "string" && domain ? (
      <a href={`https://${domain}`} target="_blank" rel="noreferrer" className="mt-1 inline-flex items-center gap-1 text-sm text-muted-foreground hover:underline">{domain} <ExternalLink className="h-3 w-3" /></a>
    ) : null,
    extra: data ? <p className="text-xs text-muted-foreground">Source: {data.account.source} · version {data.account.version} · segments: {data.account.segmentIds.join(", ") || "—"}</p> : null,
  });
  const scoreHistory = (title?: string) => data ? (
    <ScoreHistory account={data.account} fieldHistory={data.history} activities={company.activities} contactIds={data.contacts.map((c) => c.id)} versions={company.versions} title={title} />
  ) : null;
  const renderers: Renderers<ComponentOf<"account">> = {
    ...shared,
    fitBar: () => (data ? <FitBar fit={data.account.fit} explanation={explanation} /> : null),
    whyFit: (section, { held }) => data ? (
      <WhyThisFit title={section.title} explanation={explanation} citations={company.citations ?? []} values={{ industry: data.account.industry, country: data.account.country, employees: data.account.employees }}>
        {held}
      </WhyThisFit>
    ) : null,
    scoreHistory: (section, { within }) => within ? scoreHistory(section.title) : data ? <section className="border border-border bg-card p-4">{scoreHistory(section.title)}</section> : null,
    timeline: (section) => data ? (
      <AccountTimeline accountId={id} domain={data.account.domain} stream={data.account.stream} contacts={data.contacts} fieldHistory={data.history} activities={company.activities}
        refresh={company.refresh} moduleActivityUnavailable={company.moduleActivityUnavailable} userName={userName(team)} log={logLabel(p, section)} title={section.title} />
    ) : null,
    topSignals: (section) => data ? (
      <TopSignals domain={data.account.domain} title={section.title}>
        {sectionActions(section).length > 0 && <SignalsStatus actions={sectionActions(section)} ctx={p.ctx} />}
      </TopSignals>
    ) : null,
    companyDeals: (section) => data ? <CompanyDeals companyId={id} name={data.account.name} domain={data.account.domain} stream={data.account.stream} title={section.title} actions={sectionActions(section)} ctx={p.ctx} /> : null,
    peopleAcrossDeals: (section) => data ? <PeopleAcrossDeals companyId={id} domain={data.account.domain} stream={data.account.stream} currentIds={new Set(data.contacts.map((c) => c.id))} title={section.title} /> : null,
    related: (section) => <CompanyRelations accountId={id} placed={{ actions: sectionActions(section), ctx: p.ctx }} />,
  };
  return <PageSections object="account" page={p.page} stage={null} renderers={renderers} />;
}

function ContactSections(p: Page) {
  const { id, row, team, desc } = p;
  const aiFields = useContactAiFields();
  const aiAnswers = useContactAnswers([id], aiFields);
  const fields = desc.fields;
  const renderers: Renderers<ComponentOf<"contact">> = {
    ...partyRenderers(p, {}),
    aiFields: (section) => aiFields.length > 0 ? <AiFieldsPanel fields={aiFields} answers={aiAnswers?.[id]} contactId={id} actions={sectionActions(section)} ctx={p.ctx} title={section.title} /> : null,
    related: (section) => <ContactRelations contactId={id} placed={{ actions: sectionActions(section), ctx: p.ctx }} />,
    callPanel: (section) => <CallContact contactId={id} phone={phoneOf(fields, row.values)} actions={sectionActions(section)} ctx={p.ctx} title={section.title} />,
    composeEmail: (section) => <ComposeEmail contactId={id} email={emailOf(fields, row.values)} actions={sectionActions(section)} ctx={p.ctx} title={section.title} />,
    timeline: (section) => <ContactTimeline contactId={id} accountId={row.accountId || null} userName={userName(team)} log={logLabel(p, section)} title={section.title} />,
  };
  return <PageSections object="contact" page={p.page} stage={null} renderers={renderers} />;
}
