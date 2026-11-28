"use client";

import { createElement, useEffect, useId, useState, type ReactNode } from "react";
import { useConvex, useQuery } from "convex/react";
import Link from "next/link";
import { api } from "../../../convex/_generated/api";
import { stageOf, stageOutcome } from "../../../convex/lib/pipelines";
import { offered } from "../../../recipes/actions";
import type { Context } from "../../../recipes/conditions";
import { pageKind } from "../../../recipes/blocks";
import { projectedPast } from "../../../convex/lib/objects/views";
import type { BoardSaves } from "./board-view";
import { DATA_QUERIES } from "../../../recipes/data";
import { relatedCount, type RecordRelation } from "../../../recipes/recordRelations";
import { cn, getErrorMessage } from "@/lib/utils";
import { SelectField } from "@/components/ui/select";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { formatValue, type CellValue, type FieldDescription, type ObjectDescription, type TeamMember } from "./fields";
import { LookupLink } from "./lookup-field";
import { useWorkspaceMoney } from "./money";
import { DataResult } from "./data-section";
import { DataForm } from "./data-write-section";
import { createDataRecord, dataCreateFields } from "./data-create";
import { RECORDS_SAVED, useRecordsSaved } from "./record-context";
import { loadRecordRelation, relatedListHref, useRecordRelations, type RelationSource } from "./record-relation-query";
import { objectIcon } from "./object-icons";
import { btn } from "./record-parts";
import type { SectionOf } from "./page-sections";
import type { PageSpec } from "../../../recipes/kernel";
import { canChangeRecordPath } from "../../../recipes/recordPath";

type RecordBlockData = RelationSource & {
  title: string;
  values: Readonly<Record<string, unknown>>;
  version: number;
  desc: ObjectDescription;
  team?: readonly TeamMember[];
};

const card = "min-w-0 border border-border bg-card";
function fold(title: string, collapsed: boolean | undefined, body: ReactNode) {
  if (!collapsed) return body;
  return <details className={card}>
    <summary className="cursor-pointer px-4 py-2.5 text-sm font-medium">{title}</summary>
    {body}
  </details>;
}

const standardIcons: Record<string, string> = { deal: "briefcase", account: "building", contact: "users" };

const actionLabels = {
  "kernel.archive": "Archive", "kernel.restore": "Restore", "kernel.merge": "Merge",
  "kernel.findEmail": "Find email", "kernel.findPhone": "Find phone",
} as const;

export function highlightsActions(section: SectionOf<"highlights">) {
  const fromProps = [...new Set(section.props.actions)].map((runs, index) => ({ id: `highlight${index}`, label: actionLabels[runs], runs }));
  const explicit = new Set(section.actions?.map((action) => action.runs));
  return [...fromProps.filter((action) => !explicit.has(action.runs)), ...(section.actions ?? [])];
}

const keyFields: Record<string, string[]> = {
  deal: ["companyId", "amount", "closeDate", "stage", "ownerId"],
  account: ["domain", "industry", "status", "ownerId"],
  contact: ["title", "email", "phone", "lifecycleStage", "ownerId"],
};

function Highlights({ data, section, actions }: { data: RecordBlockData; section: SectionOf<"highlights">; actions?: ReactNode }) {
  const { desc, values, object, title, team } = data;
  const icon = createElement(objectIcon(desc.icon ?? standardIcons[object]), { className: "size-5", "aria-hidden": true });
  const workspaceMoney = useWorkspaceMoney();
  const money = typeof values.currency === "string" && values.currency ? { ...workspaceMoney, currency: values.currency } : workspaceMoney;
  const available = desc.fields.filter((f) => !f.hidden && f.fieldId !== desc.titleFieldId);
  const defaults = Object.hasOwn(keyFields, object) ? keyFields[object] : available.filter((f) => !f.system && ["lookup", "picklist", "date", "datetime", "currency", "number", "text", "user"].includes(f.type)).map((f) => f.apiName);
  const fields = [...new Set(section.props.fields ?? defaults)].flatMap((name) => {
    const field = available.find((f) => f.apiName === name || f.fieldId === name);
    return field ? [field] : [];
  }).slice(0, 7);
  return <section aria-label={section.title} className={card}>
    <div className="flex flex-wrap items-start justify-between gap-3 px-4 py-3">
      <div className="flex min-w-0 items-center gap-3">
        <span className="grid size-9 shrink-0 place-items-center bg-primary/10 text-primary">{icon}</span>
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground">{desc.label}</p>
          <h1 className="break-words font-display text-xl font-semibold">{title || "Untitled"}</h1>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">{actions}</div>
    </div>
    {fields.length > 0 && <dl className="flex flex-wrap gap-x-7 gap-y-2 border-t border-border px-4 py-2.5">
      {fields.map((field) => {
        const value = values[field.fieldId] as CellValue | undefined;
        return <div key={field.fieldId} className="min-w-0 max-w-full">
          <dt className="text-xs text-muted-foreground">{field.label}</dt>
          <dd className="break-words text-sm font-medium">
            {field.type === "lookup" && typeof value === "string" && value
              ? <LookupLink object={field.lookupTo} id={value} className="underline" />
              : formatValue(field, value, team, money)}
          </dd>
        </div>;
      })}
    </dl>}
  </section>;
}

type SaveField = (field: FieldDescription, value: CellValue, version: number) => Promise<boolean>;

function RecordPath({ section, data, context, save }: { section: SectionOf<"path">; data: RecordBlockData; context: Context; save?: SaveField }) {
  const [saving, setSaving] = useState(false);
  const name = section.props.field ?? (data.object === "deal" ? "stage" : undefined);
  const visible = data.desc.fields.filter((field) => !field.hidden && field.type === "picklist");
  const field = name ? visible.find((f) => f.apiName === name || f.fieldId === name) : visible.find((f) => !f.system);
  const value = field ? data.values[field.fieldId] : undefined;
  const pipelineStage = data.object === "deal" && field?.apiName === "stage";
  const pipelines = useQuery(api.pipelines.list, pipelineStage ? {} : "skip");
  const current = pipelineStage && typeof value === "string" && pipelines ? stageOf(pipelines, value) : null;
  const pipeline = current?.pipeline ?? pipelines?.find((p) => p.isDefault);
  const options = pipelineStage ? pipeline?.stages ?? [] : field && "options" in field ? field.options : [];
  const lost = current?.stage.forecastCategory === "closed_lost";
  const steps = options.filter((option) => option.active || option.value === value);
  const index = steps.findIndex((step) => step.value === value);
  const [offer] = offered(section.actions?.length ? section.actions : [{ id: "changeStage", label: "Change stage", runs: "kernel.editField" }],
    "path", ["kernel.editField"], context, {}, pageKind(data.object));
  const disabled = saving || !save || !offer || offer.disabled || !canChangeRecordPath(context.canEdit === true, field?.apiName, data.desc.readOnlyFields, steps.some((step) => step.active && step.value !== value));
  const rail = <>
    {steps.length ? <ol aria-label={field?.label} className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,7rem),1fr))] gap-x-2 gap-y-3">
      {steps.map((step, i) => <li key={step.value} aria-current={i === index ? "step" : undefined} className={cn("min-w-0 text-xs [overflow-wrap:anywhere]", i === index ? "font-semibold" : "text-muted-foreground")}>
        <span aria-hidden className={cn("mb-1.5 block h-1 rounded-full", i === index ? lost ? "bg-destructive" : "bg-primary" : i < index && !lost && (!("forecastCategory" in step) || !stageOutcome(step).isClosed) ? "bg-primary/40" : "bg-muted")} />{step.label}
      </li>)}
    </ol> : <p className="text-sm text-muted-foreground">No picklist stages available.</p>}
    {section.props.change && offer && <SelectField aria-label={offer.label} disabled={disabled} value="" className="mt-3 w-fit" onValueChange={async (next) => {
      if (disabled || !save || !field || !steps.some((step) => step.active && step.value === next && step.value !== value)) return;
      setSaving(true);
      try { await save(field, next, data.version); } finally { setSaving(false); }
    }} options={[{ value: "", label: offer.label }, ...steps.filter((step) => step.active && step.value !== value).map(({ value, label }) => ({ value, label }))]} />}
  </>;
  return section.collapsed
    ? <details className={cn(card, "p-4")}><summary className="mb-3 cursor-pointer text-sm font-medium">{section.title}</summary>{rail}</details>
    : <section aria-label={section.title} className={cn(card, "p-4")}><h2 className="mb-3 text-sm font-medium">{section.title}</h2>{rail}</section>;
}

function useRelatedRows(source: RelationSource, relation: RecordRelation, props: Partial<SectionOf<"relatedList">["props"]>, cursor?: string) {
  const client = useConvex();
  const [saved, setSaved] = useState<BoardSaves>({ n: 0, saves: [] });
  const key = JSON.stringify([source.object, source.id, source.companyId, source.version, relation, props, cursor, saved.n]);
  const [state, setState] = useState<{ key: string; data?: Awaited<ReturnType<typeof loadRecordRelation>>; error?: string }>();
  useRecordsSaved((saves) => setSaved((prev) => ({ n: prev.n + 1, saves })));
  useEffect(() => {
    let live = true;
    async function load() {
      const started = Date.now();
      let result = await loadRecordRelation(client, source, relation, props, cursor);
      while (live && Object.keys(result.rows.projectedThrough).length && !projectedPast(result.rows.projectedThrough, saved.saves) && Date.now() - started < 4000) {
        await new Promise((resolve) => setTimeout(resolve, 150));
        if (!live) break;
        result = await loadRecordRelation(client, source, relation, props, cursor);
      }
      return result;
    }
    void load().then(
      (data) => { if (live) setState({ key, data }); },
      (e: unknown) => { if (live) setState({ key, error: getErrorMessage(e) }); },
    );
    return () => { live = false; };
    // The key includes every input to this read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, key]);
  return state?.key === key ? state : undefined;
}

type NavigateRelation = (event: React.MouseEvent<HTMLAnchorElement>, relation: string) => void;

function QuickRelation({ source, relation, jump }: { source: RelationSource; relation: RecordRelation; jump?: NavigateRelation }) {
  const state = useRelatedRows(source, relation, { limit: 1 });
  if (state?.error) return null;
  return <a className="flex items-center gap-2 text-sm text-primary hover:underline" href={relatedListHref(source, relation)} onClick={(event) => jump?.(event, relation.id)}>
    {relation.label}
    <span className="border border-border bg-muted/60 px-1.5 text-xs tabular-nums text-muted-foreground">{state?.data ? relatedCount(state.data.rows.total) : "…"}</span>
  </a>;
}

function QuickLinks({ section, source, relations, jump }: { section: SectionOf<"quickLinks">; source: RelationSource; relations?: RecordRelation[]; jump: NavigateRelation }) {
  const chosen = section.props.relationships
    ? [...new Set(section.props.relationships)].flatMap((id) => relations?.find((r) => r.id === id) ?? [])
    : relations ?? [];
  return <nav aria-label={section.title} className={cn(card, "px-4 py-3")}>
    <h2 className="mb-2 text-sm font-medium">{section.title}</h2>
    <div className="flex flex-wrap gap-x-5 gap-y-2">
      {chosen.map((relation) => <QuickRelation key={relation.id} source={source} relation={relation} jump={jump} />)}
      {!chosen.length && <p className="text-sm text-muted-foreground">{relations ? "No related lists available." : "Loading related lists…"}</p>}
    </div>
  </nav>;
}

function RelatedCreate({ source, relation, desc, context, actions }: {
  source: RelationSource; relation: RecordRelation; desc: ObjectDescription; context: Context; actions: SectionOf<"relatedList">["actions"];
}) {
  const client = useConvex();
  const [open, setOpen] = useState(false);
  const team = useQuery(api.users.list, open ? {} : "skip");
  const link = relation.kind === "lookup" ? { field: relation.field, id: source.id }
    : relation.kind === "companyDeals" && (!relation.viaCompany || source.companyId)
      ? { field: "companyId", id: relation.viaCompany ? source.companyId! : source.id }
      : null;
  const field = link && desc.fields.find((f) => f.apiName === link.field && !f.hidden);
  const fields = dataCreateFields(desc).filter((f) => f.apiName !== link?.field).slice(0, 30);
  const offers = offered(actions?.length ? actions : [{ id: "newRelated", label: "New", runs: "kernel.createRecord" }], "relatedList", ["kernel.createRecord"], { ...context, canEdit: desc.canCreate }, {}, pageKind(source.object));
  const offer = offers[0];
  const enabled = Boolean(offer && !offer.disabled && link && field && !desc.readOnlyFields.includes(link.field) && fields.length);
  if (!offer) return null;
  return <>
    <button type="button" className={btn} onClick={() => setOpen(true)} disabled={!enabled}>{offer.label}</button>
    {open && link && enabled && <Dialog open onOpenChange={setOpen}>
      <DialogContent>
        <DialogTitle>New {desc.label.toLowerCase()}</DialogTitle>
        <DataForm query={DATA_QUERIES.form.parse({ object: desc.apiName, fields: fields.map((f) => f.apiName) })} desc={desc} initial={{}} team={team} buttons={[{ id: offer.action.id, label: "Create", disabled: false }]} onSubmit={async (values) => {
          const saves = await createDataRecord(client, desc, { ...values, [link.field]: link.id }, crypto.randomUUID());
          window.dispatchEvent(new CustomEvent(RECORDS_SAVED, { detail: saves }));
          setOpen(false);
        }} />
      </DialogContent>
    </Dialog>}
  </>;
}

function RelatedList({ source, section, relation, context }: { source: RelationSource; section: SectionOf<"relatedList">; relation: RecordRelation; context: Context }) {
  const state = useRelatedRows(source, relation, section.props);
  const result = state?.data;
  const icon = createElement(objectIcon(result?.desc.icon ?? standardIcons[relation.object]), { className: "mt-0.5 size-4 shrink-0 text-primary", "aria-hidden": true });
  return <section aria-label={section.title} className={card}>
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-2 border-b border-border px-4 py-2.5">
      <h2 className="flex items-start gap-2 text-sm font-medium">{icon}<span>{section.title}
        {result && <span className="ml-2 whitespace-nowrap text-xs tabular-nums text-muted-foreground">({relatedCount(result.rows.total)})</span>}</span>
      </h2>
      {result && result.canLink !== false && section.props.create && <RelatedCreate source={source} relation={relation} desc={result.desc} context={context} actions={section.actions} />}
    </div>
    <div className="px-4 py-2">
      {state?.error ? <p role="alert" className="text-sm text-muted-foreground">{state.error}</p> : result
        ? <DataResult kind="table" query={result.query} answer={result} compact />
        : <p role="status" className="text-sm text-muted-foreground">Loading records…</p>}
    </div>
    <div className="border-t border-border px-4 py-2 text-center">
      <Link className="text-sm font-medium text-primary hover:underline" href={relatedListHref(source, relation)}>View all</Link>
    </div>
  </section>;
}

export function useRecordBlockRenderers({ data, page, context, save, actions }: {
  data: RecordBlockData | null; page: PageSpec; context: Context; save?: SaveField;
  actions: (section: SectionOf<"highlights">) => ReactNode;
}) {
  const anchor = useId();
  const object = data?.object ?? "";
  const relevant = page.some((s) => s.component === "relatedList" || s.component === "quickLinks");
  const relations = useRecordRelations(object, Boolean(data) && relevant);
  const idOf = (section: SectionOf<"relatedList">) => `${anchor}-${page.indexOf(section)}`;
  const jump: NavigateRelation = (event, relation) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const root = event.currentTarget.closest("[data-record-sections]");
    if (!root) return;
    const sections = page.filter((s): s is SectionOf<"relatedList"> => s.component === "relatedList" && s.props.relationship === relation);
    const findCard = () => sections.map((section) => document.getElementById(idOf(section))).find((el) => el && root.contains(el) && el.getClientRects().length > 0);
    const inactiveTab = () => root.querySelector<HTMLButtonElement>(`[data-related-tab~="${CSS.escape(relation)}"][aria-selected="false"]`);
    if (!findCard() && !inactiveTab()) return;
    event.preventDefault();
    const visited = new Set<HTMLButtonElement>();
    const reveal = () => {
      const target = findCard();
      if (target) {
        const disclosure = target.querySelector("details");
        if (disclosure) disclosure.open = true;
        target.scrollIntoView({ block: "start" });
        target.focus({ preventScroll: true });
        return;
      }
      const tab = inactiveTab();
      if (tab && !visited.has(tab)) {
        visited.add(tab);
        tab.click();
        requestAnimationFrame(reveal);
      }
    };
    reveal();
  };
  return {
    highlights: (section: SectionOf<"highlights">) => data && fold(section.title, section.collapsed, <Highlights data={data} section={section} actions={actions(section)} />),
    path: (section: SectionOf<"path">) => data && <RecordPath data={data} section={section} context={context} save={save} />,
    quickLinks: (section: SectionOf<"quickLinks">) => data && fold(section.title, section.collapsed, <QuickLinks source={data} section={section} relations={relations} jump={jump} />),
    relatedList: (section: SectionOf<"relatedList">) => {
      if (!data) return null;
      const relation = relations?.find((r) => r.id === section.props.relationship);
      return <div id={idOf(section)} tabIndex={-1} className="scroll-mt-4">
        {relation ? fold(section.title, section.collapsed, <RelatedList source={data} section={section} relation={relation} context={context} />) :
          <section className={cn(card, "p-4")}><h2 className="text-sm font-medium">{section.title}</h2><p className="text-sm text-muted-foreground">{relations ? "Relationship unavailable." : "Loading relationship…"}</p></section>}
      </div>;
    },
  };
}

export function RecordBlocks({ children, ...options }: Parameters<typeof useRecordBlockRenderers>[0] & {
  children: (renderers: ReturnType<typeof useRecordBlockRenderers>) => ReactNode;
}) {
  return children(useRecordBlockRenderers(options));
}

export function RelatedRecordsPage({ sourceObject, sourceId, object, relationship }: { sourceObject: string; sourceId: string; object: string; relationship: string }) {
  const client = useConvex();
  const relations = useRecordRelations(sourceObject, true);
  const relation = relations?.find((r) => r.id === relationship && r.object === object);
  const [source, setSource] = useState<RelationSource | null>();
  useEffect(() => {
    let live = true;
    void client.action(api.objects.list, { object: sourceObject, filter: [{ field: "id", op: "eq", value: sourceId }], limit: 1 }).then(
      ({ rows: [row] }) => {
        if (live) setSource(row ? {
          object: sourceObject, id: sourceId,
          ...(sourceObject === "deal" && typeof row.values.companyId === "string" ? { companyId: row.values.companyId } : {}),
        } : null);
      }, () => { if (live) setSource(null); },
    );
    return () => { live = false; };
  }, [client, sourceObject, sourceId]);
  return <div className="space-y-4 p-4 sm:p-8">
    <Link href={`/dashboard/records/${encodeURIComponent(sourceObject)}/${encodeURIComponent(sourceId)}`} className="text-sm underline">Back to record</Link>
    {source && relation ? <RelatedResults source={source} relation={relation} /> :
      <p className="text-sm text-muted-foreground">{source === null || (relations && !relation) ? "Relationship unavailable." : "Loading relationship…"}</p>}
  </div>;
}

function RelatedResults({ source, relation }: { source: RelationSource; relation: RecordRelation }) {
  const [cursors, setCursors] = useState<string[]>([]);
  const state = useRelatedRows(source, relation, { limit: 50 }, cursors.at(-1));
  const result = state?.data;
  const next = result?.rows.nextCursor;
  return <section className={cn(card, "space-y-3 p-4")}>
    <h1 className="font-display text-xl font-semibold">{relation.label} {result && <span className="text-sm text-muted-foreground">({result.rows.total})</span>}</h1>
    {state?.error ? <p role="alert">{state.error}</p> : result ? <DataResult kind="table" query={result.query} answer={result} /> : <p role="status">Loading records…</p>}
    {(cursors.length > 0 || next) && <div className="flex gap-2">
      <button type="button" className={btn} disabled={!cursors.length} onClick={() => setCursors((all) => all.slice(0, -1))}>Previous</button>
      <button type="button" className={btn} disabled={!next} onClick={() => { if (next) setCursors((all) => [...all, next]); }}>Next</button>
    </div>}
  </section>;
}
