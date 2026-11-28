"use client";

import { createElement, useEffect, useId, useState, type ReactNode } from "react";
import { useConvex, useQuery } from "convex/react";
import Link from "next/link";
import { api } from "../../../convex/_generated/api";
import { stageOf, stageOutcome } from "../../../convex/lib/pipelines";
import { offered, type PageAction } from "../../../recipes/actions";
import type { Context } from "../../../recipes/conditions";
import { pageKind } from "../../../recipes/blocks";
import { projectedPast } from "../../../convex/lib/objects/views";
import type { BoardSaves } from "./board-view";
import { DATA_QUERIES } from "../../../recipes/data";
import { parentRecordRelations, recordRelations, relatedCount, type ParentRecordRelation, type RecordRelation } from "../../../recipes/recordRelations";
import { cn, getErrorMessage } from "@/lib/utils";
import { canEditRecordField, visibleRecordFields } from "../../../recipes/recordFields";
import { splitRecordActions } from "../../../recipes/recordActionBar";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { RecordSummary } from "./record-summary";
import { RecordText } from "./record-text";
import { recordHref } from "./record-target";
import { SelectField } from "@/components/ui/select";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { InlineField, isEditable, formatValue, type CellValue, type FieldDescription, type ObjectDescription, type TeamMember } from "./fields";
import { LookupField, LookupLink } from "./lookup-field";
import { useWorkspaceMoney } from "./money";
import { DataResult } from "./data-section";
import { DataForm } from "./data-write-section";
import { createDataRecord, dataCreateFields } from "./data-create";
import { RECORDS_SAVED, useRecordsSaved } from "./record-context";
import { loadParentRecord, loadRecordRelation, relatedListHref, useReadableRecordObjects, type RelationSource } from "./record-relation-query";
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
  splitTeam?: readonly TeamMember[];
};

function fold(title: string, collapsed: boolean | undefined, body: ReactNode) {
  if (!collapsed) return body;
  return <details className="record-panel">
    <RecordSummary className="record-panel-pad">{title}</RecordSummary>
    <div data-record-fold-body>{body}</div>
  </details>;
}

const standardIcons: Record<string, string> = { deal: "briefcase", account: "building", contact: "users" };

const actionLabels = {
  "kernel.archive": "Archive", "kernel.restore": "Restore", "kernel.merge": "Merge",
  "kernel.findEmail": "Find email", "kernel.findPhone": "Find phone",
} as const;

export type RecordActionHost = "highlights" | "actionBar";

function placedRecordActions(section: SectionOf<RecordActionHost>): PageAction[] {
  const fromProps = [...new Set(section.props.actions)].map((runs, index) => ({ id: `${section.component}:${index}`, label: actionLabels[runs], runs }));
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
  return <section data-record-highlights aria-label={section.title} className="record-panel">
    <div className="flex flex-wrap items-start justify-between gap-3 record-panel-pad">
      <div className="flex min-w-0 items-center gap-3">
        <span className="grid size-9 shrink-0 place-items-center bg-primary/10 text-primary">{icon}</span>
        <div className="min-w-0">
          <p className="record-label">{desc.label}</p>
          <h1 className="record-title">{title || "Untitled"}</h1>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">{actions}</div>
    </div>
    {fields.length > 0 && <dl className="flex flex-wrap gap-x-7 gap-y-2 record-panel-divider-top record-panel-pad">
      {fields.map((field) => {
        const value = values[field.fieldId] as CellValue | undefined;
        return <div key={field.fieldId} className="min-w-0 max-w-full">
          <dt className="record-label">{field.label}</dt>
          <dd className="break-words record-value">
            {field.type === "lookup" && typeof value === "string" && value
              ? <LookupLink object={field.lookupTo} id={value} className="record-link underline" />
              : formatValue(field, value, team, money)}
          </dd>
        </div>;
      })}
    </dl>}
  </section>;
}

type SaveField = (field: FieldDescription, value: CellValue, version: number) => Promise<boolean>;

function RecordFieldSection({ data, section, context, save }: { data: RecordBlockData; section: SectionOf<"fieldSection">; context: Context; save?: SaveField }) {
  const { title, fields, columns, collapsible, collapsed } = section.props;
  const money = useWorkspaceMoney();
  const recordMoney = typeof data.values.currency === "string" ? { ...money, currency: data.values.currency } : money;
  const body = <dl className={cn("record-field-grid grid record-panel-pad", columns === 2 && "sm:grid-cols-2")}>
    {visibleRecordFields(data.desc.fields, fields).map((field) => {
      const value = data.values[field.fieldId] as CellValue | undefined;
      const readOnly = !canEditRecordField(context.canEdit === true, Boolean(save) && !data.desc.register, field, data.desc.readOnlyFields) || !isEditable(field);
      const onSave = (next: CellValue, version: number) => !readOnly && save ? save(field, next, version) : Promise.resolve(false);
      return <div key={field.fieldId} className="min-w-0">
        <dt className="px-2 record-label">{field.label}</dt>
        <dd className="record-value">{field.type === "lookup"
          ? <LookupField field={field} value={value} version={data.version} readOnly={readOnly} onSave={onSave} />
          : <InlineField field={field} value={value} version={data.version} team={field.type === "splits" ? data.splitTeam : data.team} money={recordMoney} readOnly={readOnly} onSave={onSave} />}</dd>
      </div>;
    })}
  </dl>;
  const startsClosed = collapsed ?? section.collapsed;
  const heading = "record-panel-divider record-panel-pad";
  return (collapsible ?? Boolean(startsClosed))
    ? <details className="record-panel" open={!startsClosed}><RecordSummary className={heading}>{title}</RecordSummary>{body}</details>
    : <section className="record-panel" aria-label={title}><h2 className={cn(heading, "record-block-heading record-section-title")}>{title}</h2>{body}</section>;
}

function RelatedRecord({ data, relation, section }: { data: RecordBlockData; relation: ParentRecordRelation; section: SectionOf<"relatedRecord"> }) {
  const client = useConvex();
  const desc = useQuery(api.objects.describe, { object: relation.object });
  const [refresh, setRefresh] = useState(0);
  const [state, setState] = useState<{ key: string; result: Awaited<ReturnType<typeof loadParentRecord>> }>();
  useRecordsSaved(() => setRefresh((n) => n + 1));
  const fields = desc?.readable ? visibleRecordFields(desc.fields, section.props.fields) : [];
  const key = desc?.readable ? JSON.stringify([data.object, data.id, data.version, relation, relation.kind === "field" ? data.values[relation.field] : null, fields.map((field) => field.fieldId), refresh]) : null;
  useEffect(() => {
    if (key === null) return;
    const [object, id, , parent, value] = JSON.parse(key) as [string, string, number, ParentRecordRelation, unknown];
    let live = true;
    void loadParentRecord(client, { object, id }, parent, value).then(
      (result) => { if (live) setState({ key, result }); },
      () => { if (live) setState({ key, result: null }); },
    );
    return () => { live = false; };
  }, [client, key]);
  const result = desc === null || desc?.readable === false ? null : state?.key === key ? state.result : undefined;
  const workspaceMoney = useWorkspaceMoney();
  const currency = result?.values.currency;
  const money = typeof currency === "string" ? { ...workspaceMoney, currency } : workspaceMoney;
  const title = section.props.title ?? section.title;
  return <section className="record-panel" aria-label={title}>
    <h2 className="record-panel-divider record-block-heading record-panel-pad record-section-title">{result
      ? <Link href={recordHref(relation.object, result.id)} className="record-link hover:underline">{title}</Link> : title}</h2>
    {result ? <div className="record-panel-pad">
      {!fields.some((field) => field.fieldId === desc?.titleFieldId) && <Link href={recordHref(relation.object, result.id)} className="record-embedded-link record-link mb-2 underline">{result.title}</Link>}
      <dl className="record-field-grid grid">
        {fields.map((field) => <div key={field.fieldId}>
          <dt className="record-label">{field.label}</dt>
          <dd className="break-words record-value">{field.fieldId === desc?.titleFieldId
            ? <Link href={recordHref(relation.object, result.id)} className="record-link underline">{result.title}</Link>
            : formatValue(field, result.values[field.fieldId] as CellValue | undefined, data.team, money) || "—"}</dd>
        </div>)}
      </dl>
    </div> : <p className="record-panel-pad record-value text-muted-foreground">{result === undefined ? "Loading record…" : "Related record unavailable."}</p>}
  </section>;
}

type RecordAction = { menu?: boolean };
type RenderActions = (actions: readonly PageAction[], host: RecordActionHost, control?: RecordAction) => ReactNode[];

function RecordActionBar({ section, actions }: { section: SectionOf<"actionBar">; actions: RenderActions }) {
  const placed = placedRecordActions(section);
  const controls = actions(placed, "actionBar");
  const { buttons, overflow } = splitRecordActions(controls);
  if (!buttons.length) return null;
  return <section aria-label={section.title} className="record-panel flex flex-wrap items-center gap-2 record-panel-pad">
    {buttons}
    {overflow.length > 0 && <DropdownMenu>
      <DropdownMenuTrigger className={btn} aria-label="More record actions">⋯</DropdownMenuTrigger>
      <DropdownMenuContent keepMounted align="end">
        {actions(placed, "actionBar", { menu: true }).slice(buttons.length)}
      </DropdownMenuContent>
    </DropdownMenu>}
  </section>;
}

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
      {steps.map((step, i) => <li key={step.value} aria-current={i === index ? "step" : undefined} className="min-w-0 record-step [overflow-wrap:anywhere]">
        <span aria-hidden className={cn("mb-1.5 block h-1 rounded-full", i === index ? "bg-primary" : i < index && !lost && (!("forecastCategory" in step) || !stageOutcome(step).isClosed) ? "bg-primary/40" : "bg-muted")} />{step.label}
      </li>)}
    </ol> : <p className="record-value text-muted-foreground">No picklist stages available.</p>}
    {section.props.change && offer && <SelectField aria-label={offer.label} disabled={disabled} value="" className="mt-3 w-fit" onValueChange={async (next) => {
      if (disabled || !save || !field || !steps.some((step) => step.active && step.value === next && step.value !== value)) return;
      setSaving(true);
      try { await save(field, next, data.version); } finally { setSaving(false); }
    }} options={[{ value: "", label: offer.label }, ...steps.filter((step) => step.active && step.value !== value).map(({ value, label }) => ({ value, label }))]} />}
  </>;
  return section.collapsed
    ? <details className="record-panel record-panel-pad"><RecordSummary className="mb-3">{section.title}</RecordSummary>{rail}</details>
    : <section aria-label={section.title} className="record-panel record-panel-pad"><h2 className="record-block-heading mb-3 record-section-title">{section.title}</h2>{rail}</section>;
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
  return <a className="flex items-center gap-2 record-value record-link hover:underline" href={relatedListHref(source, relation)} onClick={(event) => jump?.(event, relation.id)}>
    {relation.label}
    <span className="border border-border bg-muted/60 px-1.5 record-meta tabular-nums">{state?.data ? relatedCount(state.data.rows.total) : "…"}</span>
  </a>;
}

function QuickLinks({ section, source, relations, jump }: { section: SectionOf<"quickLinks">; source: RelationSource; relations?: RecordRelation[]; jump: NavigateRelation }) {
  const chosen = section.props.relationships
    ? [...new Set(section.props.relationships)].flatMap((id) => relations?.find((r) => r.id === id) ?? [])
    : relations ?? [];
  return <nav aria-label={section.title} className="record-panel record-panel-pad">
    <h2 className="record-block-heading mb-2 record-section-title">{section.title}</h2>
    <div className="flex flex-wrap gap-x-5 gap-y-2">
      {chosen.map((relation) => <QuickRelation key={relation.id} source={source} relation={relation} jump={jump} />)}
      {!chosen.length && <p className="record-value text-muted-foreground">{relations ? "No related lists available." : "Loading related lists…"}</p>}
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
  return <section aria-label={section.title} className="record-panel">
    <div className="record-panel-actions record-panel-divider record-panel-pad">
      <h2 className="record-block-heading flex items-start gap-2 record-section-title">{icon}<span>{section.title}
        {result && <span className="ml-2 whitespace-nowrap record-meta tabular-nums">({relatedCount(result.rows.total)})</span>}</span>
      </h2>
      {result && result.canLink !== false && section.props.create && <RelatedCreate source={source} relation={relation} desc={result.desc} context={context} actions={section.actions} />}
    </div>
    <div className="record-panel-pad">
      {state?.error ? <p role="alert" className="record-value text-muted-foreground">{state.error}</p> : result
        ? <DataResult kind="table" query={result.query} answer={result} compact />
        : <p role="status" className="record-value text-muted-foreground">Loading records…</p>}
    </div>
    <div className="record-panel-divider-top record-panel-pad text-center">
      <Link className="record-value record-link hover:underline" href={relatedListHref(source, relation)}>View all</Link>
    </div>
  </section>;
}

export function useRecordBlockRenderers({ data, page, context, save, actions }: {
  data: RecordBlockData | null; page: PageSpec; context: Context; save?: SaveField;
  actions: RenderActions;
}) {
  const anchor = useId();
  const object = data?.object ?? "";
  const relatedLists = page.some((s) => s.component === "relatedList" || s.component === "quickLinks");
  const relatedRecords = page.some((s) => s.component === "relatedRecord");
  const objects = useReadableRecordObjects(Boolean(data) && (relatedLists || relatedRecords));
  const relations = objects && relatedLists ? recordRelations(object, objects) : undefined;
  const parents = objects && relatedRecords ? parentRecordRelations(object, objects) : undefined;
  const idOf = (section: SectionOf<"relatedList">) => `${anchor}-${page.indexOf(section)}`;
  const jump: NavigateRelation = (event, relation) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const root = event.currentTarget.closest("[data-record-sections]");
    if (!root) return;
    const sections = page.filter((s): s is SectionOf<"relatedList"> => s.component === "relatedList" && s.props.relationship === relation);
    const openContainers = (el: Element) => {
      for (let ancestor = el.parentElement; ancestor && ancestor !== root; ancestor = ancestor.parentElement) {
        if (ancestor instanceof HTMLDetailsElement && ancestor.dataset.layout === "card") ancestor.open = true;
      }
    };
    const findCard = () => sections.map((section) => document.getElementById(idOf(section))).find((el) => {
      if (!el || !root.contains(el)) return false;
      openContainers(el);
      return el.getClientRects().length > 0;
    });
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
        openContainers(tab);
        tab.click();
        requestAnimationFrame(reveal);
      }
    };
    reveal();
  };
  return {
    highlights: (section: SectionOf<"highlights">) => data && fold(section.title, section.collapsed, <Highlights data={data} section={section} actions={actions(placedRecordActions(section), "highlights")} />),
    path: (section: SectionOf<"path">) => data && <RecordPath data={data} section={section} context={context} save={save} />,
    quickLinks: (section: SectionOf<"quickLinks">) => data && fold(section.title, section.collapsed, <QuickLinks source={data} section={section} relations={relations} jump={jump} />),
    fieldSection: (section: SectionOf<"fieldSection">) => data && <RecordFieldSection data={data} section={section} context={context} save={save} />,
    relatedRecord: (section: SectionOf<"relatedRecord">) => {
      if (!data) return null;
      const relation = parents?.find((r) => r.id === section.props.relationship);
      const title = section.props.title ?? section.title;
      return fold(title, section.collapsed, relation ? <RelatedRecord data={data} relation={relation} section={section} /> :
        <section className="record-panel record-panel-pad"><h2 className="record-block-heading record-section-title">{title}</h2><p className="record-value text-muted-foreground">{parents ? "Relationship unavailable." : "Loading relationship…"}</p></section>);
    },
    actionBar: (section: SectionOf<"actionBar">) => data && fold(section.title, section.collapsed, <RecordActionBar section={section} actions={actions} />),
    richText: (section: SectionOf<"richText">) => data && fold(section.title, section.collapsed, <section aria-label={section.title} className="record-panel record-field-grid grid record-panel-pad">
      <h2 className="record-block-heading record-section-title">{section.title}</h2><RecordText markdown={section.props.markdown} />
    </section>),
    relatedList: (section: SectionOf<"relatedList">) => {
      if (!data) return null;
      const relation = relations?.find((r) => r.id === section.props.relationship);
      return <div id={idOf(section)} tabIndex={-1} className="scroll-mt-4">
        {relation ? fold(section.title, section.collapsed, <RelatedList source={data} section={section} relation={relation} context={context} />) :
          <section className="record-panel record-panel-pad"><h2 className="record-block-heading record-section-title">{section.title}</h2><p className="record-value text-muted-foreground">{relations ? "Relationship unavailable." : "Loading relationship…"}</p></section>}
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
  const objects = useReadableRecordObjects(true);
  const relations = objects && recordRelations(sourceObject, objects);
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
    <Link href={`/dashboard/records/${encodeURIComponent(sourceObject)}/${encodeURIComponent(sourceId)}`} className="record-value underline">Back to record</Link>
    {source && relation ? <RelatedResults source={source} relation={relation} /> :
      <p className="record-value text-muted-foreground">{source === null || (relations && !relation) ? "Relationship unavailable." : "Loading relationship…"}</p>}
  </div>;
}

function RelatedResults({ source, relation }: { source: RelationSource; relation: RecordRelation }) {
  const [cursors, setCursors] = useState<string[]>([]);
  const state = useRelatedRows(source, relation, { limit: 50 }, cursors.at(-1));
  const result = state?.data;
  const next = result?.rows.nextCursor;
  return <section className="record-panel space-y-3 record-panel-pad">
    <h1 className="record-title">{relation.label} {result && <span className="record-meta">({result.rows.total})</span>}</h1>
    {state?.error ? <p role="alert">{state.error}</p> : result ? <DataResult kind="table" query={result.query} answer={result} /> : <p role="status">Loading records…</p>}
    {(cursors.length > 0 || next) && <div className="flex gap-2">
      <button type="button" className={btn} disabled={!cursors.length} onClick={() => setCursors((all) => all.slice(0, -1))}>Previous</button>
      <button type="button" className={btn} disabled={!next} onClick={() => { if (next) setCursors((all) => [...all, next]); }}>Next</button>
    </div>}
  </section>;
}
