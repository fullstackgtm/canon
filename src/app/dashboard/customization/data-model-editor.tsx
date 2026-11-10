"use client";

import { useState } from "react";
import Link from "next/link";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { ArrowDown, ArrowUp, Archive, Eye, EyeOff, Pencil, Undo2 } from "lucide-react";
import { api } from "../../../../convex/_generated/api";
import { BUILDER_TYPES, LOOKUP_TARGETS, type BuilderType, type ComputeSpec } from "../../../../convex/lib/objects/fieldBuilder";
import { COMPUTED_TYPES, FUNCTIONS, ROLLUP_FNS, type ComputedType, type RollupFn } from "../../../../convex/lib/objects/formula";
import { canBeUnique, OBJECT_ICONS, PICKLIST_COLORS, STANDARD_OBJECTS, type FieldType, type ObjectIcon } from "../../../../convex/lib/objects/registry";
import { RULES_BY_TYPE, type FieldRule } from "../../../../convex/lib/objects/rules";
import { LoadingRows } from "@/components/dashboard";
import { OPTION_CHIP } from "@/components/records/fields";
import { OBJECT_ICON_COMPONENTS, objectIcon } from "@/components/records/object-icons";
import { toast } from "@/lib/toast";
import { cn, getErrorMessage } from "@/lib/utils";
import { SelectField } from "@/components/ui/select";

/** A standard object's apiName, or an org's own object's (`custom_<slug>`). */
type Modeled = string;
type FieldsData = NonNullable<FunctionReturnType<typeof api.dataModel.fields>>;
type FieldRow = FieldsData["fields"][number];
type RollupSource = FieldsData["rollupSources"][number];
type OptionDraft = { value?: string; label: string; color?: string; active: boolean };

const TYPE_LABEL: Record<string, string> = {
  text: "Text", number: "Number", currency: "Currency", date: "Date", datetime: "Date and time", checkbox: "Checkbox",
  picklist: "Picklist", multipicklist: "Multi-select", lookup: "Lookup", user: "User", emails: "Emails", phones: "Phones", links: "Links", formula: "Formula", rollup: "Rollup",
};

const RETURNS_LABEL: Record<ComputedType, string> = { number: "Number", currency: "Currency", text: "Text", date: "Date", datetime: "Date and time", checkbox: "Checkbox" };
const FN_LABEL: Record<RollupFn, string> = { count: "Count", sum: "Sum", min: "Earliest or lowest", max: "Latest or highest", avg: "Average" };

const btn = "inline-flex items-center gap-1 border border-border px-2 py-1 text-xs hover:bg-muted disabled:opacity-40";
const input = "border border-border bg-background px-2 py-1 text-sm";
const takesRules = (t: string) => t in RULES_BY_TYPE;
const hasOptions = (t: string) => t === "picklist" || t === "multipicklist";

/** Recipes, Data model: each object's standard and custom fields; admins add, rename, hide, archive and edit options (CP7a). */
export function DataModelTab() {
  const objects = useQuery(api.dataModel.objects);
  const salesforce = useQuery(api.customObjects.salesforceObjects);
  const me = useQuery(api.users.me, {});
  // What the page shows: an object of the builder, an object Salesforce owns, or the new-object form.
  const [shown, setShown] = useState<{ kind: "object" | "salesforce"; apiName: string } | { kind: "new" }>({ kind: "object", apiName: "account" });
  if (objects === undefined) return <LoadingRows count={3} />;
  if (objects === null) return null;
  const standard = objects.filter((o) => !o.custom);
  const own = objects.filter((o) => o.custom);
  const pick = (o: { apiName: string; pluralLabel: string; customFields: number; icon?: string | null; archived?: boolean }, kind: "object" = "object") => {
    const Icon = o.icon ? objectIcon(o.icon) : null;
    const on = shown.kind === kind && "apiName" in shown && shown.apiName === o.apiName;
    return (
      <button
        key={o.apiName}
        type="button"
        onClick={() => setShown({ kind, apiName: o.apiName })}
        className={cn("flex items-center justify-between gap-2 border px-3 py-2 text-left text-sm", on ? "border-primary bg-muted" : "border-border hover:bg-muted", o.archived && "opacity-60")}
      >
        <span className="flex items-center gap-2">{Icon && <Icon className="h-3.5 w-3.5 text-muted-foreground" />}{o.pluralLabel}</span>
        {o.customFields > 0 && <span className="text-xs text-muted-foreground">{o.customFields}</span>}
      </button>
    );
  };
  const heading = "mt-3 text-xs font-medium text-muted-foreground";
  return (
    <div className="grid grid-cols-1 gap-6 md:grid-cols-[13rem_1fr]">
      <nav aria-label="Objects" className="grid content-start gap-1">
        {standard.map((o) => pick(o))}
        <h3 className={heading}>Your objects</h3>
        {own.map((o) => pick(o))}
        {me?.role === "admin" && (
          <button type="button" onClick={() => setShown({ kind: "new" })} className={cn(btn, "justify-center py-2", shown.kind === "new" && "border-primary bg-muted")}>New object</button>
        )}
        {salesforce && salesforce.length > 0 && (
          <>
            <h3 className={heading}>From Salesforce</h3>
            {salesforce.map((o) => (
              <button
                key={o.apiName}
                type="button"
                onClick={() => setShown({ kind: "salesforce", apiName: o.apiName })}
                className={cn("flex justify-between border px-3 py-2 text-left text-sm", shown.kind === "salesforce" && shown.apiName === o.apiName ? "border-primary bg-muted" : "border-border hover:bg-muted")}
              >
                <span>{o.label}</span>
              </button>
            ))}
          </>
        )}
      </nav>
      {shown.kind === "new" ? (
        <NewObject onCreated={(apiName) => setShown({ kind: "object", apiName })} />
      ) : shown.kind === "salesforce" ? (
        <SalesforceObject key={shown.apiName} apiName={shown.apiName} label={salesforce?.find((o) => o.apiName === shown.apiName)?.label ?? shown.apiName} />
      ) : (
        <ObjectFields key={shown.apiName} object={shown.apiName} />
      )}
    </div>
  );
}

const ICON_LABEL: Record<ObjectIcon, string> = {
  folder: "Folder", briefcase: "Briefcase", box: "Box", calendar: "Calendar", flag: "Flag", star: "Star", heart: "Heart", file: "File", users: "People", building: "Building", tag: "Tag", wrench: "Wrench",
};

/** A choice of icons from the fixed set a custom object may have. */
function IconPicker({ value, onChange }: { value: ObjectIcon; onChange: (next: ObjectIcon) => void }) {
  return (
    <div role="radiogroup" aria-label="Icon" className="flex flex-wrap gap-1">
      {OBJECT_ICONS.map((name) => {
        const Icon = OBJECT_ICON_COMPONENTS[name];
        return (
          <button key={name} type="button" role="radio" aria-checked={value === name} aria-label={ICON_LABEL[name]} title={ICON_LABEL[name]} onClick={() => onChange(name)}
            className={cn("border p-1.5", value === name ? "border-primary bg-muted" : "border-border hover:bg-muted")}>
            <Icon className="h-4 w-4" />
          </button>
        );
      })}
    </div>
  );
}

/** Create an object of the org's own: its names, an icon, and its primary name field. Fields come after, from the same page. */
function NewObject({ onCreated }: { onCreated: (apiName: string) => void }) {
  const create = useMutation(api.customObjects.create);
  const { busy, run } = useRun();
  const [label, setLabel] = useState("");
  const [pluralLabel, setPluralLabel] = useState("");
  const [plural, setPlural] = useState(false);
  const [titleLabel, setTitleLabel] = useState("Name");
  const [icon, setIcon] = useState<ObjectIcon>("folder");
  const plurals = plural ? pluralLabel : label.trim() ? `${label.trim()}s` : "";
  return (
    <section>
      <h2 className="font-display text-xl font-semibold">New object</h2>
      <p className="mb-3 text-sm text-muted-foreground">
        An object of your own gets a list with filters, saved views and a board, record pages with history, bulk edit, CSV export, search, the API and webhooks.
        Its id is chosen now and never changes; you can rename it later.
      </p>
      <form
        className="grid max-w-xl gap-3 border border-border bg-card p-4"
        onSubmit={(e) => {
          e.preventDefault();
          void (async () => {
            let made: { apiName: string } | undefined;
            const ok = await run(async () => { made = await create({ label, pluralLabel: plurals, icon, titleLabel }); }, `Created ${label.trim()}`);
            if (ok && made) onCreated(made.apiName);
          })();
        }}
      >
        <label className="grid gap-1 text-xs">
          Name (singular)
          <input aria-label="Object name" autoFocus required value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Project" className={input} />
        </label>
        <label className="grid gap-1 text-xs">
          Plural name
          <input aria-label="Plural name" required value={plurals} onChange={(e) => { setPlural(true); setPluralLabel(e.target.value); }} placeholder="Projects" className={input} />
        </label>
        <label className="grid gap-1 text-xs">
          Primary name field
          <input aria-label="Primary name field" required value={titleLabel} onChange={(e) => setTitleLabel(e.target.value)} className={input} />
        </label>
        <div className="grid gap-1 text-xs">
          Icon
          <IconPicker value={icon} onChange={setIcon} />
        </div>
        <div className="flex gap-1">
          <button type="submit" disabled={busy || !label.trim() || !plurals.trim() || !titleLabel.trim()} className={btn}>Create object</button>
        </div>
      </form>
    </section>
  );
}

/**
 * Rename an object, change its icon, or archive it (hidden, data kept) and bring it back. A standard object can only
 * be renamed, and goes back to Canon's names.
 */
function ObjectSettings({ object, label, pluralLabel, icon, archived }: { object: Modeled; label: string; pluralLabel: string; icon: string | null; archived: boolean }) {
  const edit = useMutation(api.customObjects.edit);
  const relabel = useMutation(api.dataModel.relabel);
  const standard = Object.hasOwn(STANDARD_OBJECTS, object) ? STANDARD_OBJECTS[object as keyof typeof STANDARD_OBJECTS] : null;
  const renamed = standard !== null && (standard.label !== label || standard.pluralLabel !== pluralLabel);
  const setArchived = useMutation(api.customObjects.setArchived);
  const { busy, run } = useRun();
  const [draft, setDraft] = useState<{ label: string; pluralLabel: string; icon: ObjectIcon } | null>(null);
  if (draft) {
    return (
      <form
        className="mb-4 grid max-w-xl gap-3 border border-border bg-card p-4"
        onSubmit={(e) => {
          e.preventDefault();
          const save = standard ? relabel({ object, label: draft.label, pluralLabel: draft.pluralLabel }) : edit({ apiName: object, ...draft });
          void run(() => save, "Saved").then((ok) => ok && setDraft(null));
        }}
      >
        <label className="grid gap-1 text-xs">Name (singular)<input aria-label="Object name" autoFocus required value={draft.label} onChange={(e) => setDraft({ ...draft, label: e.target.value })} className={input} /></label>
        <label className="grid gap-1 text-xs">Plural name<input aria-label="Plural name" required value={draft.pluralLabel} onChange={(e) => setDraft({ ...draft, pluralLabel: e.target.value })} className={input} /></label>
        {!standard && <div className="grid gap-1 text-xs">Icon<IconPicker value={draft.icon} onChange={(next) => setDraft({ ...draft, icon: next })} /></div>}
        <div className="flex gap-1">
          <button type="submit" disabled={busy} className={btn}>Save</button>
          <button type="button" onClick={() => setDraft(null)} className={btn}>Cancel</button>
        </div>
      </form>
    );
  }
  return (
    <div className="mb-4 flex flex-wrap items-center gap-2 text-sm">
      <span className="text-muted-foreground">Id <span className="font-mono text-foreground">{object}</span>. A rename changes labels only.</span>
      {!archived && <button type="button" disabled={busy} onClick={() => setDraft({ label, pluralLabel, icon: (OBJECT_ICONS as readonly string[]).includes(icon ?? "") ? (icon as ObjectIcon) : "folder" })} className={btn}><Pencil className="h-3 w-3" /> Rename</button>}
      {standard ? (
        renamed && <button type="button" disabled={busy} onClick={() => void run(() => relabel({ object, label: "", pluralLabel: "" }), `Back to ${standard.pluralLabel}`)} className={btn}><Undo2 className="h-3 w-3" /> Use Canon&apos;s names</button>
      ) : archived ? (
        <button type="button" disabled={busy} onClick={() => void run(() => setArchived({ apiName: object, archived: false }), "Restored")} className={btn}><Undo2 className="h-3 w-3" /> Restore object</button>
      ) : (
        <button
          type="button"
          disabled={busy}
          onClick={() => { if (window.confirm(`Archive ${pluralLabel}? It leaves the nav, search and the API; its records are kept.`)) void run(() => setArchived({ apiName: object, archived: true }), "Archived"); }}
          className={btn}
        >
          <Archive className="h-3 w-3" /> Archive object
        </button>
      )}
    </div>
  );
}

/**
 * An object imported from Salesforce, read only. Salesforce owns its schema: the fields come from its describe, and its
 * records live in the record service's generic tables, outside the ledger the field builder and the list pages read. A change
 * here would diverge from Salesforce at the next import, so there is none; Canon objects are created above instead.
 */
function SalesforceObject({ apiName, label }: { apiName: string; label: string }) {
  const fields = useQuery(api.salesforceMetadata.listFields, { object: apiName });
  return (
    <section>
      <h2 className="font-display text-xl font-semibold">{label}</h2>
      <p className="mb-3 text-sm text-muted-foreground">
        Imported from Salesforce as <span className="font-mono">{apiName}</span>. Salesforce owns this definition, so it is read only here.
      </p>
      {fields === undefined ? <LoadingRows count={4} /> : (
        <table className="w-full border border-border text-sm">
          <thead className="bg-muted/50 text-left text-xs font-medium text-muted-foreground">
            <tr><th className="px-3 py-2">Field</th><th className="px-3 py-2">Salesforce type</th><th className="px-3 py-2">API name</th><th className="px-3 py-2">Writable</th></tr>
          </thead>
          <tbody>
            {fields.map((f) => (
              <tr key={f.apiName} className="border-t border-border">
                <td className="px-3 py-2 font-medium">{f.label}</td>
                <td className="px-3 py-2">{f.type}</td>
                <td className="px-3 py-2 font-mono text-xs">{f.apiName}</td>
                <td className="px-3 py-2">{f.updateable ? "Yes" : "No"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function ObjectFields({ object }: { object: Modeled }) {
  const data = useQuery(api.dataModel.fields, { object });
  const [adding, setAdding] = useState(false);
  if (data === undefined) return <LoadingRows count={4} />;
  if (data === null) return null;
  const live = data.fields.filter((f) => f.archivedAt === undefined);
  const archived = data.fields.filter((f) => f.archivedAt !== undefined);
  return (
    <section>
      {data.canEditObject && <ObjectSettings object={object} label={data.label} pluralLabel={data.pluralLabel} icon={data.icon} archived={data.archived} />}
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h2 className="font-display text-xl font-semibold">{data.pluralLabel}{data.archived ? " (archived)" : ""}</h2>
          <p className="text-sm text-muted-foreground">
            {data.canEdit ? "Add your own fields. A rename keeps saved views, imports and the API working." : "Only admins change fields."}{" "}
            {!data.archived && <Link href={`/dashboard/records/${object}`} className="underline">Open the list</Link>}
          </p>
        </div>
        {data.canEdit && !adding && <button type="button" onClick={() => setAdding(true)} className={btn}>New field</button>}
      </div>
      {adding && <NewField object={object} fields={data.fields} sources={data.rollupSources} onDone={() => setAdding(false)} />}
      <table className="w-full border border-border text-sm">
        <thead className="bg-muted/50 text-left text-xs font-medium text-muted-foreground">
          <tr><th className="px-3 py-2">Field</th><th className="px-3 py-2">Type</th><th className="px-3 py-2">API name</th><th className="px-3 py-2" /></tr>
        </thead>
        <tbody>
          {live.map((f) => <FieldLine key={f.fieldId} object={object} field={f} canEdit={data.canEdit} fields={data.fields} sources={data.rollupSources} />)}
        </tbody>
      </table>
      {archived.length > 0 && (
        <>
          <h3 className="mb-2 mt-6 text-xs font-medium text-muted-foreground">Archived</h3>
          <p className="mb-2 text-sm text-muted-foreground">Archived fields are off views and forms. Their values stay in each record&apos;s history; restoring one brings them back.</p>
          <table className="w-full border border-border text-sm text-muted-foreground">
            <tbody>{archived.map((f) => <FieldLine key={f.fieldId} object={object} field={f} canEdit={data.canEdit} fields={data.fields} sources={data.rollupSources} />)}</tbody>
          </table>
        </>
      )}
    </section>
  );
}

function useRun() {
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true);
    try {
      await fn();
      if (ok) void toast.success(ok);
      return true;
    } catch (cause) {
      void toast.error(getErrorMessage(cause));
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { busy, run };
}

function FieldLine({ object, field, canEdit, fields, sources }: { object: Modeled; field: FieldRow; canEdit: boolean; fields: readonly FieldRow[]; sources: readonly RollupSource[] }) {
  const update = useMutation(api.dataModel.updateFieldDef);
  const setArchived = useMutation(api.dataModel.setArchived);
  const { busy, run } = useRun();
  const [label, setLabel] = useState<string | null>(null);
  const [options, setOptions] = useState<OptionDraft[] | null>(null);
  const [checks, setChecks] = useState(false);
  const [compute, setCompute] = useState<ComputeSpec | null>(null);
  const computed = field.type === "formula" && "returns" in field ? field : null;
  const custom = field.kind === "custom";
  const archived = field.archivedAt !== undefined;
  const own = useQuery(api.customObjects.list);
  const target = field.type === "lookup" && "lookupTo" in field
    ? STANDARD_OBJECTS[field.lookupTo as keyof typeof STANDARD_OBJECTS]?.label ?? own?.find((o) => o.apiName === field.lookupTo)?.label ?? null
    : null;
  const opts = "options" in field ? field.options : [];
  const claiming = field.uniqueClaiming !== undefined;
  const refused = !field.unique && !claiming && field.uniqueCheck?.status === "failed" ? field.uniqueCheck.error : null;
  const uniqueAble = custom && !computed && canBeUnique(field.type as FieldType);
  const setUnique = (on: boolean) => {
    // Companies and people nobody has worked yet hold no claim: they are checked now, and held to it when someone edits them.
    const unworked = on && (object === "account" || object === "contact") ? " Companies and people nobody has worked yet are checked now; each is held to it the next time someone edits it." : "";
    const ask = on ? `Make ${field.label} unique? Canon checks every record for a value two of them share first; with none, no two records can take one value again.${unworked}` : `Stop holding ${field.label} unique? Records may then share a value.`;
    if (window.confirm(ask)) void run(() => update({ object, fieldId: field.fieldId, unique: on }), on ? "Checking for duplicates. Progress is in the activity tray." : "No longer unique");
  };

  return (
    <>
      <tr className="border-t border-border align-top">
        <td className="px-3 py-2">
          {label !== null ? (
            <form
              className="flex gap-1"
              onSubmit={(e) => {
                e.preventDefault();
                void run(() => update({ object, fieldId: field.fieldId, label }), "Renamed").then((ok) => ok && setLabel(null));
              }}
            >
              <input aria-label="Field name" autoFocus value={label} onChange={(e) => setLabel(e.target.value)} className={input} />
              <button type="submit" disabled={busy} className={btn}>Save</button>
              <button type="button" onClick={() => setLabel(null)} className={btn}>Cancel</button>
            </form>
          ) : (
            <span className="font-medium">{field.label}</span>
          )}
          <span className="ml-2 text-xs text-muted-foreground">
            {field.isName ? "Name" : field.kind === "standard" ? "Standard" : field.kind === "ai" ? "AI field" : "Custom"}
            {field.hidden ? " · hidden" : ""}
          </span>
          {(field.required || field.rules?.length || field.unique || claiming) && !checks ? (
            <div className="mt-1 flex flex-wrap gap-1 text-xs">
              {field.required && <span className="border border-border px-1.5 py-0.5">Required</span>}
              {field.unique && <span className="border border-border px-1.5 py-0.5">Unique</span>}
              {claiming && <span className="border border-border px-1.5 py-0.5">Checking for duplicates…</span>}
              {field.rules?.map((r) => <span key={r.kind} className="border border-border px-1.5 py-0.5">{ruleSummary(r)}</span>)}
            </div>
          ) : null}
          {refused && <p role="status" className="mt-1 max-w-prose text-xs text-destructive">{refused}</p>}
          {computed && !compute && <ComputeSummary field={computed} sources={sources} />}
          {hasOptions(field.type) && !options && (
            <div className="mt-1 flex flex-wrap gap-1">
              {opts.filter((o) => o.active).map((o) => <span key={o.value} className={cn("px-1.5 py-0.5 text-xs", OPTION_CHIP[o.color ?? "gray"])}>{o.label}</span>)}
            </div>
          )}
        </td>
        <td className="px-3 py-2">
          {computed ? `${computed.rollup ? "Rollup" : "Formula"}, ${RETURNS_LABEL[computed.returns].toLowerCase()}` : `${TYPE_LABEL[field.type] ?? field.type}${target ? ` to ${target}` : ""}`}
        </td>
        <td className="px-3 py-2 font-mono text-xs">{field.apiName}</td>
        <td className="px-3 py-2">
          {field.kind === "ai" && <Link href="/dashboard/fields" className="text-xs underline">AI fields</Link>}
          {custom && canEdit && (
            <div className="flex flex-wrap justify-end gap-1">
              {archived ? (
                <button type="button" disabled={busy} onClick={() => void run(() => setArchived({ object, fieldId: field.fieldId, archived: false }), "Restored")} className={btn}><Undo2 className="h-3 w-3" /> Restore</button>
              ) : (
                <>
                  <button type="button" disabled={busy} onClick={() => setLabel(field.label)} className={btn}><Pencil className="h-3 w-3" /> Rename</button>
                  {computed ? (
                    <button type="button" disabled={busy} onClick={() => setCompute({ formula: computed.formula, returns: computed.returns, ...(computed.rollup ? { rollup: computed.rollup } : {}) })} className={btn}>
                      {computed.rollup ? "Edit rollup" : "Edit formula"}
                    </button>
                  ) : (
                    <button type="button" disabled={busy} onClick={() => setChecks(true)} className={btn}>{takesRules(field.type) ? "Required and rules" : "Required"}</button>
                  )}
                  {hasOptions(field.type) && <button type="button" disabled={busy} onClick={() => setOptions(opts.map((o) => ({ ...o })))} className={btn}>Options</button>}
                  {uniqueAble && <button type="button" disabled={busy} onClick={() => setUnique(!(field.unique || claiming))} className={btn}>{field.unique || claiming ? "Not unique" : "Make unique"}</button>}
                  {!field.isName && (
                    <>
                      <button type="button" disabled={busy} onClick={() => void run(() => update({ object, fieldId: field.fieldId, hidden: !field.hidden }), field.hidden ? "Shown" : "Hidden")} className={btn}>
                        {field.hidden ? <><Eye className="h-3 w-3" /> Show</> : <><EyeOff className="h-3 w-3" /> Hide</>}
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => { if (window.confirm(`Archive ${field.label}? It leaves views and forms; its values stay in history.`)) void run(() => setArchived({ object, fieldId: field.fieldId, archived: true }), "Archived"); }}
                        className={btn}
                      >
                        <Archive className="h-3 w-3" /> Archive
                      </button>
                    </>
                  )}
                </>
              )}
            </div>
          )}
        </td>
      </tr>
      {checks && (
        <tr className="border-t border-border">
          <td colSpan={4} className="px-3 py-3">
            <RulesEditor
              field={field}
              busy={busy}
              onCancel={() => setChecks(false)}
              onSave={(required, rules) => void run(() => update({ object, fieldId: field.fieldId, required, rules }), "Saved").then((ok) => ok && setChecks(false))}
            />
          </td>
        </tr>
      )}
      {compute && (
        <tr className="border-t border-border">
          <td colSpan={4} className="px-3 py-3">
            <ComputeEditor rollup={computed?.rollup !== undefined} value={compute} onChange={setCompute} fields={fields} sources={sources} />
            <div className="mt-2 flex gap-1">
              <button type="button" disabled={busy} onClick={() => void run(() => update({ object, fieldId: field.fieldId, compute }), "Saved").then((ok) => ok && setCompute(null))} className={btn}>Save</button>
              <button type="button" onClick={() => setCompute(null)} className={btn}>Cancel</button>
            </div>
          </td>
        </tr>
      )}
      {options && (
        <tr className="border-t border-border">
          <td colSpan={4} className="px-3 py-3">
            <OptionsEditor
              options={options}
              onChange={setOptions}
              busy={busy}
              onCancel={() => setOptions(null)}
              onSave={() => void run(() => update({ object, fieldId: field.fieldId, options }), "Options saved").then((ok) => ok && setOptions(null))}
            />
          </td>
        </tr>
      )}
    </>
  );
}

const ruleSummary = (r: FieldRule) => {
  switch (r.kind) {
    case "pattern": return `Pattern ${r.pattern}`;
    case "min": return `Min ${r.value}`;
    case "max": return `Max ${r.value}`;
    case "maxLength": return `Max ${r.value} characters`;
    case "date": return r.when === "notPast" ? "Not in the past" : "Not in the future";
    case "oneOf": return `One of ${r.values.join(", ")}`;
  }
};

/**
 * Mark a custom field required and set its rules (CP7b). Text takes a pattern, a
 * maximum length and a list of allowed values; numbers a minimum and maximum;
 * dates a not-past or not-future check. Every write checks them: the record page,
 * CSV, the API, MCP and agent proposals.
 */
function RulesEditor({ field, busy, onSave, onCancel }: { field: FieldRow; busy: boolean; onSave: (required: boolean, rules: FieldRule[]) => void; onCancel: () => void }) {
  const current = (field.rules ?? []) as FieldRule[];
  const find = <K extends FieldRule["kind"]>(kind: K) => current.find((r): r is Extract<FieldRule, { kind: K }> => r.kind === kind);
  const [required, setRequired] = useState(field.required === true);
  const [pattern, setPattern] = useState(find("pattern")?.pattern ?? "");
  const [message, setMessage] = useState(find("pattern")?.message ?? "");
  const [maxLength, setMaxLength] = useState(String(find("maxLength")?.value ?? ""));
  const [oneOf, setOneOf] = useState(find("oneOf")?.values.join(", ") ?? "");
  const [min, setMin] = useState(String(find("min")?.value ?? ""));
  const [max, setMax] = useState(String(find("max")?.value ?? ""));
  const [when, setWhen] = useState<string>(find("date")?.when ?? "");
  const kinds = RULES_BY_TYPE[field.type] ?? [];
  const build = (): FieldRule[] => [
    ...(kinds.includes("pattern") && pattern.trim() ? [{ kind: "pattern" as const, pattern: pattern.trim(), message: message.trim() }] : []),
    ...(kinds.includes("maxLength") && maxLength.trim() ? [{ kind: "maxLength" as const, value: Number(maxLength) }] : []),
    ...(kinds.includes("oneOf") && oneOf.trim() ? [{ kind: "oneOf" as const, values: oneOf.split(",").map((x) => x.trim()).filter(Boolean) }] : []),
    ...(kinds.includes("min") && min.trim() ? [{ kind: "min" as const, value: Number(min) }] : []),
    ...(kinds.includes("max") && max.trim() ? [{ kind: "max" as const, value: Number(max) }] : []),
    ...(kinds.includes("date") && when ? [{ kind: "date" as const, when: when as "notPast" | "notFuture" }] : []),
  ];
  return (
    <div className="grid gap-3">
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={required} onChange={(e) => setRequired(e.target.checked)} /> Required: a new record must set it and an edit cannot clear it
      </label>
      <div className="flex flex-wrap gap-3">
        {kinds.includes("pattern") && (
          <>
            <label className="grid gap-1 text-xs">Pattern (regular expression)<input aria-label="Pattern" value={pattern} onChange={(e) => setPattern(e.target.value)} placeholder="^E-\d{4}$" className={cn(input, "font-mono")} /></label>
            <label className="grid gap-1 text-xs">Message when it fails<input aria-label="Pattern message" value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Use the form E-1234" className={input} /></label>
          </>
        )}
        {kinds.includes("maxLength") && <label className="grid gap-1 text-xs">Maximum length<input aria-label="Maximum length" inputMode="numeric" value={maxLength} onChange={(e) => setMaxLength(e.target.value)} className={cn(input, "w-24")} /></label>}
        {kinds.includes("oneOf") && <label className="grid gap-1 text-xs">One of (comma separated)<input aria-label="One of" value={oneOf} onChange={(e) => setOneOf(e.target.value)} className={input} /></label>}
        {kinds.includes("min") && <label className="grid gap-1 text-xs">Minimum<input aria-label="Minimum" inputMode="decimal" value={min} onChange={(e) => setMin(e.target.value)} className={cn(input, "w-28")} /></label>}
        {kinds.includes("max") && <label className="grid gap-1 text-xs">Maximum<input aria-label="Maximum" inputMode="decimal" value={max} onChange={(e) => setMax(e.target.value)} className={cn(input, "w-28")} /></label>}
        {kinds.includes("date") && (
          <label className="grid gap-1 text-xs">Date rule
            <SelectField aria-label="Date rule" value={when} onValueChange={setWhen}
              options={[{ value: "", label: "None" }, { value: "notPast", label: "Not in the past" }, { value: "notFuture", label: "Not in the future" }]} />
          </label>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        Rules check the value being written, so records that already break one are not blocked from unrelated edits. Salesforce and HubSpot syncs are never refused by them.
      </p>
      <div className="flex gap-1">
        <button type="button" disabled={busy} onClick={() => onSave(required, build())} className={btn}>Save</button>
        <button type="button" onClick={onCancel} className={btn}>Cancel</button>
      </div>
    </div>
  );
}

/** Add, rename, reorder, colour and archive a picklist's options. An option records hold is archived, never removed. */
function OptionsEditor({ options, onChange, busy, onSave, onCancel }: {
  options: OptionDraft[]; onChange: (next: OptionDraft[]) => void; busy?: boolean; onSave?: () => void; onCancel?: () => void;
}) {
  const set = (i: number, patch: Partial<OptionDraft>) => onChange(options.map((o, j) => (j === i ? { ...o, ...patch } : o)));
  const move = (i: number, by: number) => {
    const next = [...options];
    [next[i], next[i + by]] = [next[i + by], next[i]];
    onChange(next);
  };
  return (
    <div className="grid gap-1">
      {options.map((o, i) => (
        <div key={o.value ?? `new-${i}`} className={cn("flex flex-wrap items-center gap-1", !o.active && "opacity-60")}>
          <SelectField aria-label={`Colour of ${o.label || "option"}`} value={o.color ?? ""} onValueChange={(v) => set(i, { color: v || undefined })} className={cn("w-28", OPTION_CHIP[o.color ?? ""])}
            options={[{ value: "", label: "No colour" }, ...PICKLIST_COLORS.map((c) => ({ value: c, label: c }))]} />
          <input aria-label={`Option ${i + 1}`} value={o.label} onChange={(e) => set(i, { label: e.target.value })} className={input} />
          <button type="button" aria-label="Move up" disabled={i === 0} onClick={() => move(i, -1)} className={btn}><ArrowUp className="h-3 w-3" /></button>
          <button type="button" aria-label="Move down" disabled={i === options.length - 1} onClick={() => move(i, 1)} className={btn}><ArrowDown className="h-3 w-3" /></button>
          {o.value === undefined ? (
            <button type="button" onClick={() => onChange(options.filter((_, j) => j !== i))} className={btn}>Remove</button>
          ) : (
            <button type="button" onClick={() => set(i, { active: !o.active })} className={btn}>{o.active ? "Archive" : "Restore"}</button>
          )}
        </div>
      ))}
      <div className="mt-1 flex gap-1">
        <button type="button" onClick={() => onChange([...options, { label: "", active: true }])} className={btn}>Add option</button>
        {onSave && <button type="button" disabled={busy} onClick={onSave} className={btn}>Save options</button>}
        {onCancel && <button type="button" onClick={onCancel} className={btn}>Cancel</button>}
      </div>
    </div>
  );
}

/** A new rollup's starting definition: a count of `object` (the first source by default) by its first lookup here. */
function firstRollup(sources: readonly RollupSource[], object = sources[0]?.object): ComputeSpec {
  const s = sources.find((x) => x.object === object);
  return s ? { formula: "", rollup: { object: s.object, via: s.via[0].fieldId, fn: "count" } } : { formula: "" };
}

/** What a formula or rollup field computes, as a line under its name. */
function ComputeSummary({ field, sources }: { field: Extract<FieldRow, { type: "formula" }>; sources: readonly RollupSource[] }) {
  const r = field.rollup;
  if (!r) return <div className="mt-1 font-mono text-xs text-muted-foreground">= {field.formula}</div>;
  const source = sources.find((s) => s.object === r.object);
  const read = r.field ? ` of ${source?.fields.find((f) => f.fieldId === r.field)?.label ?? r.field}` : "";
  return (
    <div className="mt-1 text-xs text-muted-foreground">
      {FN_LABEL[r.fn]}{read} across {source?.pluralLabel.toLowerCase() ?? r.object} by {source?.via.find((v) => v.fieldId === r.via)?.label ?? r.via}
      {field.formula ? <span className="font-mono"> where {field.formula}</span> : null}
    </div>
  );
}

/**
 * The definition of a formula or rollup field. A formula is an expression over the record's own fields, by API name; a
 * rollup totals a field of the records whose lookup points here, optionally only those a true-or-false expression holds for.
 */
function ComputeEditor({ rollup, value, onChange, fields, sources }: {
  rollup: boolean; value: ComputeSpec; onChange: (next: ComputeSpec) => void; fields: readonly FieldRow[]; sources: readonly RollupSource[];
}) {
  if (!rollup) {
    const names = fields.filter((f) => f.archivedAt === undefined && !(f.type === "formula" && !("rollup" in f && f.rollup))).map((f) => f.apiName);
    return (
      <div className="grid gap-2">
        <div className="flex flex-wrap gap-3">
          <label className="grid min-w-[22rem] flex-1 gap-1 text-xs">
            Formula
            <textarea aria-label="Formula" rows={2} value={value.formula} onChange={(e) => onChange({ ...value, formula: e.target.value })} placeholder="daysBetween(today(), closeDate)" className={cn(input, "font-mono")} />
          </label>
          <label className="grid content-start gap-1 text-xs">
            Gives
            <SelectField aria-label="Formula type" value={value.returns ?? "number"} onValueChange={(v) => onChange({ ...value, returns: v as ComputedType })}
              options={COMPUTED_TYPES.map((t) => ({ value: t, label: RETURNS_LABEL[t] }))} />
          </label>
        </div>
        <p className="text-xs text-muted-foreground">
          Use + - * /, = != &lt; &lt;= &gt; &gt;=, and, or, not, &quot;text&quot; and {FUNCTIONS.map((f) => `${f}()`).join(", ")}.
          Currency fields read in whole units. Fields: <span className="font-mono">{names.join(", ")}</span>
        </p>
      </div>
    );
  }
  const r = value.rollup;
  const source = sources.find((s) => s.object === r?.object);
  if (!sources.length) return <p className="text-sm text-muted-foreground">No object has a lookup pointing here yet, so there is nothing to roll up.</p>;
  const pick = (object: string) => onChange(firstRollup(sources, object));
  if (!r || !source) return null;
  // A sum or average reads numbers and money; the earliest or latest also reads dates.
  const readable = (fn: RollupFn) => source.fields.filter((f) => fn === "min" || fn === "max" || f.type === "number" || f.type === "currency");
  const set = (patch: Partial<NonNullable<ComputeSpec["rollup"]>>) => {
    const next = { ...r, ...patch };
    if (next.fn === "count") delete next.field;
    else if (!next.field) next.field = readable(next.fn)[0]?.fieldId;
    onChange({ ...value, rollup: next });
  };
  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap gap-3">
        <label className="grid gap-1 text-xs">Records<SelectField aria-label="Rollup object" value={r.object} onValueChange={pick} className="w-full" options={sources.map((s) => ({ value: s.object, label: s.pluralLabel }))} /></label>
        <label className="grid gap-1 text-xs">Linked by<SelectField aria-label="Rollup lookup" value={r.via} onValueChange={(via) => set({ via })} className="w-full" options={source.via.map((v) => ({ value: v.fieldId, label: v.label }))} /></label>
        <label className="grid gap-1 text-xs">Calculation<SelectField aria-label="Rollup calculation" value={r.fn} onValueChange={(v) => set({ fn: v as RollupFn })} className="w-full" options={ROLLUP_FNS.map((f) => ({ value: f, label: FN_LABEL[f] }))} /></label>
        {r.fn !== "count" && (
          <label className="grid gap-1 text-xs">Of<SelectField aria-label="Rollup field" value={r.field ?? ""} onValueChange={(field) => set({ field })} className="w-full" options={readable(r.fn).map((f) => ({ value: f.fieldId, label: f.label }))} /></label>
        )}
      </div>
      <label className="grid gap-1 text-xs">
        Only {source.pluralLabel.toLowerCase()} where (optional)
        <input aria-label="Rollup filter" value={value.formula} onChange={(e) => onChange({ ...value, formula: e.target.value })} placeholder="not isClosed" className={cn(input, "font-mono")} />
      </label>
      <p className="text-xs text-muted-foreground">The filter is a true-or-false formula over each {source.label.toLowerCase()}: <span className="font-mono">{source.filterable.map((f) => f.apiName).join(", ")}</span></p>
    </div>
  );
}

function NewField({ object, fields, sources, onDone }: { object: Modeled; fields: readonly FieldRow[]; sources: readonly RollupSource[]; onDone: () => void }) {
  const create = useMutation(api.dataModel.createField);
  const { busy, run } = useRun();
  const [label, setLabel] = useState("");
  const [type, setType] = useState<BuilderType>("text");
  const [lookupTo, setLookupTo] = useState<string>("account");
  const own = useQuery(api.customObjects.list);
  const [options, setOptions] = useState<OptionDraft[]>([{ label: "", active: true }]);
  const [compute, setCompute] = useState<ComputeSpec>({ formula: "", returns: "number" });
  const computes = type === "formula" || type === "rollup";
  return (
    <form
      className="mb-4 grid gap-3 border border-border bg-card p-4"
      onSubmit={(e) => {
        e.preventDefault();
        void run(() => create({
          object, label, type,
          ...(hasOptions(type) ? { options: options.filter((o) => o.label.trim()).map(({ label: l, color }) => ({ label: l, ...(color ? { color } : {}) })) } : {}),
          ...(type === "lookup" ? { lookupTo } : {}),
          ...(type === "formula" ? { compute: { formula: compute.formula, returns: compute.returns } } : type === "rollup" ? { compute: { formula: compute.formula, rollup: compute.rollup } } : {}),
        }), `Added ${label.trim()}`).then((ok) => ok && onDone());
      }}
    >
      <div className="flex flex-wrap gap-3">
        <label className="grid gap-1 text-xs">
          Name
          <input aria-label="New field name" autoFocus required value={label} onChange={(e) => setLabel(e.target.value)} className={input} />
        </label>
        <label className="grid gap-1 text-xs">
          Type
          <SelectField aria-label="New field type" value={type} onValueChange={(v) => { const next = v as BuilderType; setType(next); setCompute(next === "rollup" ? firstRollup(sources) : { formula: "", returns: "number" }); }}
            options={BUILDER_TYPES.map((t) => ({ value: t, label: TYPE_LABEL[t] }))} />
        </label>
        {type === "lookup" && (
          <label className="grid gap-1 text-xs">
            Points at
            <SelectField aria-label="Lookup object" value={lookupTo} onValueChange={setLookupTo}
              options={[
                ...LOOKUP_TARGETS.map((o) => ({ value: o, label: STANDARD_OBJECTS[o].label })),
                ...(own ?? []).filter((o) => !o.archived && o.apiName !== object).map((o) => ({ value: o.apiName, label: o.label })),
              ]} />
          </label>
        )}
      </div>
      {hasOptions(type) && <OptionsEditor options={options} onChange={setOptions} />}
      {computes && <ComputeEditor rollup={type === "rollup"} value={compute} onChange={setCompute} fields={fields} sources={sources} />}
      <div className="flex gap-1">
        <button type="submit" disabled={busy || !label.trim()} className={btn}>Add field</button>
        <button type="button" onClick={onDone} className={btn}>Cancel</button>
      </div>
    </form>
  );
}
