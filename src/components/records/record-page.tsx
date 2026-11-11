"use client";

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { useAction, useMutation, useQuery } from "convex/react";
import { Archive, Undo2, UserCheck } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import { ModulePanels } from "../modules/module-panels";
import type { Id } from "../../../convex/_generated/dataModel";
import { LoadingCards } from "@/components/dashboard";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { toast } from "@/lib/toast";
import { cn, getErrorMessage } from "@/lib/utils";
import { FIELD_EDITOR, InlineField, type CellValue, type FieldDescription, type ObjectDescription, type TeamMember } from "./fields";
import { DealTimeline, LeadTimeline } from "@/components/crm/signals-ui";
import { DealPlay, NO_PLAY, type RecordRenderers } from "@/components/crm/deal-play";
import { DEAL_FRAME, DEFAULT_DEAL_PAGE, groupFields, isFieldsSection, offered, sectionActions, type PageSection, type PageSpec } from "../../../recipes";
import { PageSections } from "./page-sections";
import { ConvertLeadDialog } from "./convert-lead";
import { saveOf, saveProblem } from "./list-view";
import { LookupField } from "./lookup-field";
import { useWorkspaceMoney } from "./money";
import { DealRelations } from "./related-lists";
import { DealGaps } from "@/components/crm/deal-gaps";
import { FieldGroups, Frame, History, SOURCE_LABEL, btn, type InDialog } from "./record-parts";
import { RunRule } from "./run-rule";
import { RecordBoundary } from "./record-boundary";
import { CRM_NAME, CrmFieldNote } from "./crm-note";
import { groupOf } from "../../../convex/lib/canon/personHold";
import { RecordLink } from "./record-context";
import { recordListOf } from "./record-target";
import { RegisterRecordPage } from "./register-page";
import { DealProducts } from "./deal-products";
import { useShapeMode } from "./shape/shape-mode";

/** Any record but a deal: its fields, timeline and history in one block. */
const RECORD_PAGE: PageSpec = [{ component: "fieldGrid" }];
/**
 * A deal page written before its recipe could place the header, products, credit splits and apps (`oldFrame`, from
 * the recipe's version) draws them where they always were. Those aren't the recipe's, so customize mode doesn't offer
 * them. A newer page that leaves them all out shows none.
 */
const framed = (page: PageSpec, old: boolean): PageSpec => !old || page.some((s) => DEAL_FRAME.includes(s.component)) ? page : [
  { component: "header", actions: [{ id: "archive", label: "Archive", runs: "kernel.archive" }, { id: "restore", label: "Restore", runs: "kernel.restore" }] },
  ...page, { component: "products" }, { component: "splits" }, { component: "apps" },
];

type WritableObject = "lead" | "task" | "note" | "call" | "meeting" | "product";
type EditableObject = WritableObject | "deal";

/** A page laid out by a recipe draft instead of the workspace's recipe in force: the recipe editor's preview. */
export type PreviewLayout = { page: PageSpec; hasPlays: boolean };

export function RecordPage({ object, id, inDialog, layout }: { object: string; id: string; inDialog?: InDialog; layout?: PreviewLayout }) {
  // Accounts and contacts are register rows, named by their record-service id rather than a stream id.
  if (object === "account" || object === "contact") return <RegisterRecordPage object={object} id={id} inDialog={inDialog} layout={layout?.page} />;
  return <LedgerRecordPage object={object} id={id} inDialog={inDialog} layout={layout} />;
}

/** A record over the page it was opened from. Escape, a click outside or the back button closes it. */
export function RecordDialog({ object, id, onClose, onSaved }: { object: string; id: string; onClose: () => void } & InDialog) {
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent
        aria-describedby={undefined}
        className="record-dialog rounded-none max-h-[90dvh] gap-0 overflow-hidden p-0 sm:max-w-5xl"
        // Escape in a field being edited cancels that edit only; the field handles it.
        onEscapeKeyDown={(e) => { if (document.activeElement?.closest(FIELD_EDITOR)) e.preventDefault(); }}
      >
        <DialogTitle className="sr-only">Record</DialogTitle>
        <RecordBoundary key={JSON.stringify([object, id])} onClose={onClose}>
          <div className="record-dialog-body"><RecordPage object={object} id={id} inDialog={{ onSaved }} /></div>
        </RecordBoundary>
      </DialogContent>
    </Dialog>
  );
}

/**
 * A ledger record's formula and rollup values (CP7c). The record service computes them as it lists, and the hot row
 * holds none, so they are read by id, again whenever the record's version moves (once the projector has applied it).
 */
function useComputedValues(object: string, id: string, desc: ObjectDescription | null | undefined, version: number | undefined) {
  const list = useAction(api.objects.list);
  const [values, setValues] = useState<Readonly<Record<string, CellValue>>>({});
  const computed = Boolean(desc?.fields.some((f) => f.type === "formula"));
  useEffect(() => {
    if (!computed || version === undefined) return;
    let current = true;
    void (async () => {
      for (let attempt = 0; attempt < 6 && current; attempt++) {
        const row = (await list({ object, filter: [{ field: "id", op: "eq", value: id }], limit: 1 }).catch(() => null))?.rows[0];
        if (row && row.version >= version) {
          if (current) setValues(row.values as Record<string, CellValue>);
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    })();
    return () => {
      current = false;
    };
  }, [list, object, id, computed, version]);
  return values;
}

function LedgerRecordPage({ object, id, inDialog, layout }: { object: string; id: string; inDialog?: InDialog; layout?: PreviewLayout }) {
  const desc = useQuery(api.objects.describe, { object });
  const streamId = id as Id<"canonEntities">;
  const record = useQuery(api.objects.get, { streamId });
  const computed = useComputedValues(object, id, desc, record?.version);
  const team = useQuery(api.users.list) as TeamMember[] | undefined;
  const workspaceMoney = useWorkspaceMoney();
  const splitTeam = useQuery(api.objects.splitMembers, object === "deal" && record && desc?.fields.some((f) => f.type === "splits") ? { streamId } : "skip");
  const write = useAction(api.objects.writeScoped);
  // What a CRM says about the deal's fields where a person's value held (lib/canon/personHold.ts).
  const crmClaims = useQuery(api.fieldClaims.forRecord, object === "deal" ? { streamId } : "skip");
  // Deal fields an admin set to always follow a CRM: a person's edit there lasts until the CRM's next write.
  const follows = useQuery(api.crmDisagreements.follows, object === "deal" ? {} : "skip");
  const remove = useMutation(api.objects.remove);
  const restore = useMutation(api.objects.restore);
  const [busy, setBusy] = useState(false);
  const [converting, setConverting] = useState(false);
  // The workspace's deal page recipe lays out a deal: its play's sections and the record's, in its order.
  const recipe = useQuery(api.recipes.forOrg, object === "deal" && !layout ? {} : "skip");
  // Shape mode (prototype): an admin reshapes the deal page in words and judges it on this page.
  const shapeRecipeId = object === "deal" && !layout && !inDialog && recipe?.canEdit ? recipe.dealPage.id : null;
  const recipeMarkdown = useQuery(api.workspaceRecipes.markdown, shapeRecipeId ? { recipeId: shapeRecipeId } : "skip");
  const shape = useShapeMode({ base: recipe?.dealPage.sections ?? [], markdown: shapeRecipeId ? recipeMarkdown?.markdown ?? null : null, recipeId: shapeRecipeId, revision: recipeMarkdown?.revision ?? null, recipeTitle: recipe?.dealPage.title });

  if (desc === undefined || record === undefined || (object === "deal" && !layout && recipe === undefined)) return <div className="p-4 sm:p-8"><LoadingCards /></div>;
  if (desc === null || record === null || record.object !== object) {
    return (
      <div className="p-4 sm:p-8">
        <p className="text-sm text-muted-foreground">This record doesn&apos;t exist in this workspace.</p>
        <Link href={recordListOf(object, "").href} className="mt-4 inline-block text-sm underline">Back to the list</Link>
      </div>
    );
  }

  // A record with no hot row and a stream past the read cap is shown as of an older version: never edit that as if current.
  const writable = desc.writable && record.lifecycle.status === "active" && record.complete;
  const fields = (desc as ObjectDescription).fields;
  const splitField = object === "deal" ? fields.find((f) => f.apiName === "splitAllocations" && !f.hidden) : undefined;
  const shownFields = fields.filter((f) => !f.hidden && f !== splitField);
  // A deal's money is in its own currency; any other record's in the workspace's.
  const money = typeof record.values.currency === "string" && record.values.currency && object === "deal" ? { ...workspaceMoney, currency: record.values.currency } : workspaceMoney;

  async function saveField(field: FieldDescription, value: CellValue, expectedVersion: number): Promise<boolean> {
    try {
      const r = await write({ object: object as EditableObject, streamId, values: { [field.apiName]: value } as never, expectedVersion });
      const problem = saveProblem(r);
      if (problem) void toast.error(problem);
      else if (r.status === "proposed") void toast.success(`${field.label} change proposed for review`);
      inDialog?.onSaved(saveOf(r));
      return !problem;
    } catch (cause) {
      void toast.error(getErrorMessage(cause));
      return false;
    }
  }

  async function lifecycle(op: "delete" | "restore") {
    setBusy(true);
    try {
      const r = await (op === "delete" ? remove : restore)({ object: object as WritableObject, streamId, expectedVersion: record!.version });
      const problem = saveProblem(r);
      if (problem) void toast.error(problem);
      else if (r.status === "proposed") void toast.success(op === "delete" ? "Archive proposed for review" : "Restore proposed for review");
      else void toast.success(op === "delete" ? "Archived" : "Restored");
      inDialog?.onSaved(saveOf(r));
    } catch (cause) {
      void toast.error(getErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  const deleted = record.lifecycle.status === "deleted";
  const active = record.lifecycle.status === "active";
  const dealPage = object === "deal" ? layout ? { sections: layout.page, hasPlays: layout.hasPlays } : recipe?.dealPage : undefined;
  const playMounted = Boolean(dealPage?.hasPlays) && !inDialog && active;
  const page: PageSpec = object === "deal" ? framed(shapeRecipeId ? shape.page : dealPage?.sections ?? [], !layout && Boolean(recipe?.dealPage.oldFrame)) : RECORD_PAGE;
  const toGroups = (groups: ReturnType<typeof groupFields<FieldDescription>>) =>
    groups.filter((g) => g.fields.length > 0).map((g) => ({ section: g.section, title: g.section.title, collapsed: Boolean(g.section.collapsed), fields: g.fields }));
  const sectionGroups = toGroups(groupFields(page, shownFields));
  const gridGroups = object === "deal" ? toGroups(groupFields(DEFAULT_DEAL_PAGE, shownFields)) : [{ title: "Details", collapsed: false, fields: shownFields }];
  const lastFields = page.filter(isFieldsSection).at(-1);
  const renderField = (f: FieldDescription) => {
    const meta = record.meta[f.fieldId];
    return (
      <div key={f.fieldId} className="grid grid-cols-[minmax(6rem,10rem)_minmax(0,1fr)] items-center gap-3 border-b border-border py-1.5 last:border-b-0 [&>*]:min-w-0 [&>*]:break-words">
        <dt className="text-xs font-medium text-muted-foreground">
          {f.label}
          {meta?.state === "contested" && <span className="ml-1 text-amber-600" title="Sources disagree on this value">· contested</span>}
          {(() => {
            const crms = follows?.filter((x) => x.object === "deal" && x.field === groupOf("deal", f.apiName)).map((x) => CRM_NAME[x.provider]) ?? [];
            return crms.length > 0 && <span className="mt-0.5 block normal-case tracking-normal text-[10px]" title="An admin set this field to always follow the CRM">Follows {crms.join(" and ")}: an edit here lasts until its next sync</span>;
          })()}
          {meta?.sourceKind && meta.sourceKind !== "user" && (
            // The value shown is another source's: a person's edit wins only while it is the newest fact.
            <span className="mt-0.5 block normal-case tracking-normal text-[10px]" title="The value shown comes from this source">from {SOURCE_LABEL[meta.sourceKind] ?? meta.sourceKind}</span>
          )}
        </dt>
        <dd>
          {f.apiName === "createdAt" || f.apiName === "updatedAt" ? (
            <span className="block px-2 py-1 text-sm">{new Date(f.apiName === "createdAt" ? record.createdAt : record.updatedAt).toLocaleString()}</span>
          ) : f.type === "lookup" ? (
            <LookupField field={f} value={record.values[f.fieldId] as CellValue | undefined} version={record.version} readOnly={!writable || desc.readOnlyFields.includes(f.apiName)} onSave={(next, expected) => saveField(f, next, expected)} />
          ) : (
            <InlineField field={f} value={(f.type === "formula" ? computed[f.fieldId] : record.values[f.fieldId]) as CellValue | undefined} version={record.version} team={f.type === "splits" ? splitTeam : team} money={money} readOnly={!writable || desc.readOnlyFields.includes(f.apiName)} onSave={(next, expected) => saveField(f, next, expected)} />
          )}
          {crmClaims?.filter((c) => c.field === f.fieldId).map((c) => <CrmFieldNote key={c.id} claim={c} canTake={writable && !desc.readOnlyFields.includes(f.apiName)} fields={fields} team={team} money={money} />)}
        </dd>
      </div>
    );
  };
  const version = <p className="text-xs text-muted-foreground">Version {record.version}</p>;
  const timeline = object === "deal" ? <DealTimeline dealId={id} companyId={typeof record.values.companyId === "string" ? record.values.companyId : null} userName={(user) => team?.find((u) => u._id === user)?.name ?? "A teammate"} />
    : object === "lead" ? <LeadTimeline leadId={id} userName={(user) => team?.find((u) => u._id === user)?.name ?? "A teammate"} /> : null;
  const history = <History streamId={streamId} fields={fields} team={[...(team ?? []), ...(splitTeam ?? [])]} />;
  const related = object === "deal" ? <DealRelations streamId={streamId} /> : null;
  // A merged record is neither archived nor restored; it lives on in the one it merged into.
  const canArchive = Boolean(desc.canDelete && desc.writable && record.complete && record.lifecycle.status !== "merged");
  const archiveButton = (label: string, disabled?: boolean) => <button key="archive" type="button" disabled={busy || disabled} onClick={() => void lifecycle("delete")} className={btn}><Archive className="h-3 w-3" /> {label}</button>;
  const restoreButton = (label: string, disabled?: boolean) => <button key="restore" type="button" disabled={busy || disabled} onClick={() => void lifecycle("restore")} className={btn}><Undo2 className="h-3 w-3" /> {label}</button>;
  function header(actions: ReactNode) {
    return (
      <div className="record-header">
        <div>
          <div className="text-xs font-medium text-muted-foreground">{desc!.label}</div>
          <h1 className="font-display text-3xl font-semibold">{record!.title || "Untitled"}</h1>
          {deleted && <p className="mt-1 text-sm text-destructive">Archived. Restore it to edit.</p>}
          {!record!.complete && (
            <p className="mt-1 text-sm text-amber-600">This record&apos;s history is too long to read here, so it shows version {record!.version}, which may not be current. It can&apos;t be edited on this page.</p>
          )}
          {record!.lifecycle.status === "merged" && <p className="mt-1 text-sm text-muted-foreground">Merged into another record.</p>}
        </div>
        <div className="record-header-actions">{actions}{!deleted && <RunRule object={object} id={streamId} />}</div>
      </div>
    );
  }
  // A section the recipe folds opens on its title.
  const folded = (section: PageSection, fallback: string, body: ReactNode) => section.collapsed && body ? (
    <details className="border border-border bg-card p-4">
      <summary className="cursor-pointer text-sm font-medium">{section.title ?? fallback}</summary>
      <div className="mt-3">{body}</div>
    </details>
  ) : body;
  const recordSections: RecordRenderers = {
    // A deal's header offers the archive and restore its recipe lists, in its order.
    header: (section, { stage }) => <>
      {header(sectionActions(section).flatMap((a) => offered([a], "header", [a.runs], { canEdit: writable, canDelete: canArchive, deleted, ...(stage ? { stage } : {}) }, {}, "deal").map((o) =>
        a.runs === "kernel.restore" ? restoreButton(o.label, o.disabled) : a.runs === "kernel.archive" ? archiveButton(o.label, o.disabled) : null)))}
      {/* The deal's missing company and people, up front: Canon's proposals to accept or dismiss (convex/dealGaps.ts). */}
      {!inDialog && !deleted && <div className="mb-6"><DealGaps streamId={streamId} onChanged={() => {}} /></div>}
    </>,
    products: (section) => folded(section, "Products", <DealProducts deal={streamId} version={record.version} amount={typeof record.values.amount === "number" ? record.values.amount : null} currency={String(record.values.currency ?? "USD")} active={active && record.complete} canEditAmount={writable && !desc.readOnlyFields.includes("amount")} title={section.title ?? "Products"} />),
    splits: (section) => folded(section, "Credit splits", splitField ? (
      <section aria-label={section.title ?? "Credit splits"} className="border border-border bg-card p-4">
        <h2 className="mb-2 text-sm font-medium">{section.title ?? "Credit splits"}</h2>
        <InlineField field={splitField} value={record.values[splitField.fieldId] as CellValue | undefined} version={record.version} team={splitTeam} readOnly={!writable || desc.readOnlyFields.includes(splitField.apiName)} onSave={(next, expected) => saveField(splitField, next, expected)} />
      </section>
    ) : null),
    apps: (section) => folded(section, "Apps", inDialog ? null : <ModulePanels page="deal" record={id} />),
    fields: (section) => {
      const group = sectionGroups.find((g) => g.section === section);
      return group ? <><FieldGroups groups={[group]} field={renderField} />{section === lastFields && version}</> : null;
    },
    timeline: () => timeline,
    history: () => history,
    related: () => related,
    fieldGrid: (section) => {
      const body = (
        <>
          <div className="grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <div className="grid grid-cols-[minmax(0,1fr)] content-start gap-4"><FieldGroups groups={gridGroups} field={renderField} />{version}</div>
            <div className="grid grid-cols-[minmax(0,1fr)] content-start gap-6">{timeline}{history}</div>
          </div>
          {related}
        </>
      );
      return section.collapsed && !inDialog && active ? (
        <details>
          <summary className="mb-4 cursor-pointer rounded-lg border border-border bg-card p-4 text-xs font-medium text-muted-foreground">{section.title ?? "Record details & history"}</summary>
          {body}
        </details>
      ) : body;
    },
  };
  const converted = typeof record.values.convertedAt === "number" ? record.values.convertedAt : null;
  return (
    <Frame object={object} id={id} plural={desc.pluralLabel} inDialog={inDialog}>
      {object !== "deal" && header(
        <>
          {object === "lead" && !converted && !deleted && writable && (
            <button type="button" onClick={() => setConverting(true)} className={cn(btn, "bg-primary text-primary-foreground hover:bg-primary/85")}><UserCheck className="h-3 w-3" /> Convert</button>
          )}
          {canArchive && (deleted ? restoreButton("Restore") : archiveButton("Archive"))}
        </>,
      )}
      {converted && (
        <p className="mb-4 border border-border bg-muted/40 px-3 py-2 text-sm">
          Converted {new Date(converted).toLocaleDateString()}
          {[["account", record.values.convertedAccountId, "company"], ["contact", record.values.convertedContactId, "person"], ["deal", record.values.convertedDealId, "deal"]].flatMap(([o, id, noun]) =>
            typeof id === "string" && id ? [<span key={o as string}> · <RecordLink object={o as string} id={id} className="underline">View {noun as string}</RecordLink></span>] : [])}
        </p>
      )}
      {object === "lead" && (
        <ConvertLeadDialog leadId={id} open={converting} onClose={() => setConverting(false)} onConverted={() => inDialog?.onSaved([])} />
      )}
      {shape.provider(playMounted ? <DealPlay streamId={id} amount={typeof record.values.amount === "number" ? record.values.amount : null} currency={typeof record.values.currency === "string" ? record.values.currency : null} team={team} page={page} record={recordSections} /> : <PageSections object="deal" page={page} stage={null} renderers={{ ...NO_PLAY, ...recordSections }} />)}
    </Frame>
  );
}
