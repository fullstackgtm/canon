"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { ArrowDown, ArrowUp, GripVertical, Paperclip, Plus, X } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import { FILE_DEFAULT_BYTES, caseOf, choiceDescriptions, choiceLabels, choicesFor, coreOf, fileFits, inheritInto, literalChoices, widgetOf, type FieldSpec, type FileValidator, type ObjectValidator, type RefValidator, type ValidatorJSON, type Widget } from "../../../modules/kernel/schema";
import { renderFilled, type TextScope } from "../../../modules/kernel/text";
import { getErrorMessage } from "@/lib/utils";
import { DateInput } from "@/components/ui/date-input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { SelectField } from "@/components/ui/select";
import { cn } from "@/lib/utils";

/**
 * A module form's fields (docs/modules.md, "Forms and widgets"): every widget a field's schema implies, nested ones
 * included. A list edits rows (add, remove, reorder), an object its fields, a variant the fields of the case its
 * sibling picks, a ref picks a deal, team or module doc from what the person may read. The form holds a draft (text
 * as typed); `fromDraft` turns it into the values an op writes, and the server checks them again.
 */

const btn = "inline-flex items-center gap-1 border border-border px-2 py-1 text-xs font-medium hover:bg-muted disabled:opacity-50";
const input = "w-full border border-border bg-background px-2 py-1 text-sm";
const labelCls = "text-xs font-medium text-muted-foreground";

export const human = (field: string) => field.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase()).replace(/ ([A-Z])/g, (_m, c: string) => ` ${c.toLowerCase()}`);

/** A field a form shows: its name, label and widget, and its spec, which nested editors draw from. */
/** `collection`: the collection whose docs a `suggest` text field offers values from. */
/**
 * `placeholder`: what its empty input says; `descriptions`: a line under each choice; `path`: where a nested field sits
 * in its doc (`config.metric`), which its `suggest` reads.
 */
export type FormFieldInfo = {
  field: string; label: string; widget: Widget; required: boolean; spec: FieldSpec | null; help?: string | null; choices?: ReadonlyArray<string | number | boolean> | null;
  labels?: Record<string, string> | null; collection?: string | null; placeholder?: string | null; descriptions?: Record<string, string> | null; path?: string;
  /** Per choice, a tag beside it (options' `badge`): a member's role. */
  badges?: Record<string, string> | null;
};
export type Draft = unknown;
type Drafts = Record<string, Draft>;

/** What every field editor reads: the module (for ref pickers), the members, what refs show as and the files docs hold. */
/** `collectionLabels`: what one doc of each collection is called ("Team group"), for a picker's "Pick a team group". */
/** `text`: the page's text scope, which a placeholder over a related doc renders with (money, percent, dates). */
export type FormEnv = { module: string; members: ReadonlyArray<{ id: string; name: string }>; inactive?: ReadonlyArray<{ id: string; name: string }>; refLabels: Record<string, string>; files?: Readonly<Record<string, { name: string; bytes: number }>>; collectionLabels?: Readonly<Record<string, string>>; text?: TextScope };
const Env = createContext<FormEnv>({ module: "", members: [], refLabels: {} });
export const FormEnvProvider = Env.Provider;
/**
 * The values of the forms around a nested editor, nearest last, with the ref fields among them: what an `inherit` field
 * takes and what a placeholder over a related doc (`{$ruleKey.config.rate}`) reads the doc's key from.
 */
type Around = { values: Record<string, unknown>; refs: Record<string, RefValidator> };
const AroundCtx = createContext<Around>({ values: {}, refs: {} });
/** An `inherit` field's value from the form around it, when that form holds one: the field then isn't shown. */
const inherited = (f: FormFieldInfo, around: Around): unknown => (f.spec?.inherit ? around.values[f.spec.inherit] ?? undefined : undefined);

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
/** A nested object's fields as a form shows them, each with the widget its spec implies. */
const fieldsOfObject = (o: ObjectValidator, at?: Nested): FormFieldInfo[] => ((o as { order?: string[] }).order ?? Object.keys(o.value)).flatMap((name) => {
  const spec = o.value[name];
  const widget = spec ? widgetOf(spec) : null;
  if (!spec) return [];
  return widget ? [{
    field: name, label: spec.label ?? human(name), widget, required: !spec.optional, spec, help: spec.help ?? null, choices: literalChoices(spec.fieldType), labels: choiceLabels(spec.fieldType),
    placeholder: spec.placeholder ?? null, descriptions: choiceDescriptions(coreOf(spec.fieldType)), ...(at ? { collection: at.collection, path: `${at.path}.${name}` } : {}),
  }] : [];
});
/** Where a nested editor sits: the collection its doc belongs to and the path of the field it edits. */
type Nested = { collection: string; path: string };
/** The nesting a field's own editors carry down, when it belongs to a collection's doc. */
const nestedOf = (f: FormFieldInfo): Nested | undefined => (f.collection ? { collection: f.collection, path: f.path ?? f.field } : undefined);
const typeOf = (f: FormFieldInfo): ValidatorJSON | null => (f.spec ? coreOf(f.spec.fieldType) : null);

/** A stored value as the form holds it: text for inputs, money in whole units, a percent of a fraction, rows and fields as drafts. */
export function toDraft(f: FormFieldInfo, value: unknown, siblings: Record<string, unknown> = {}): Draft {
  const t = typeOf(f);
  switch (f.widget) {
    case "bool": return value === true;
    case "tristate": return value === true ? "yes" : value === false ? "no" : "";
    case "money": return typeof value === "number" ? String(value / 100) : "";
    case "percent": return typeof value === "number" ? String(Math.round(value * 1e6) / 1e4) : "";
    // A time in ms, edited as its UTC day.
    case "time": return typeof value === "number" && Number.isFinite(value) ? new Date(value).toISOString().slice(0, 10) : "";
    case "object": return t?.type === "object" ? objectDraft(t, value) : {};
    case "variant": {
      const shape = f.spec?.fieldType.type === "variant" ? caseOf(f.spec.fieldType, siblings) : null;
      return shape ? objectDraft(shape, value) : {};
    }
    case "list": {
      if (!Array.isArray(value) || t?.type !== "array") return [];
      const item = itemField(t.value);
      return item ? value.map((x) => toDraft(item, x)) : [];
    }
    default: return value === undefined || value === null ? "" : String(value);
  }
}
const objectDraft = (o: ObjectValidator, value: unknown): Drafts => {
  const v = isRecord(value) ? value : {};
  const out: Drafts = {};
  for (const f of fieldsOfObject(o)) out[f.field] = toDraft(f, v[f.field], v);
  return out;
};
/** A form's drafts from a doc's values (or none): each field's, a variant's in the case its sibling picks. */
export const draftsFor = (fields: readonly FormFieldInfo[], data: Record<string, unknown>): Drafts =>
  Object.fromEntries(fields.map((f) => [f.field, toDraft(f, data[f.field], data)]));
/** The drafts with one field changed; a variant that field picks the case of starts afresh. */
export function setField(fields: readonly FormFieldInfo[], values: Drafts, field: string, d: Draft): Drafts {
  const next = { ...values, [field]: d };
  for (const f of fields) if (f.spec?.fieldType.type === "variant" && f.spec.fieldType.variantOf === field) next[f.field] = {};
  // A ref that sits under the doc this field names (a rule under its plan) no longer fits once that doc changes.
  for (const f of fields) { const t = typeOf(f); if (t?.type === "ref" && t.parent === field && f.field !== field && values[field] !== d) next[f.field] = ""; }
  // A choice narrowed by this field (an operator by the field it tests) drops a value it no longer offers.
  for (const f of fields) {
    const by = f.spec?.choicesBy;
    if (by?.sibling !== field || f.field === field) continue;
    const allowed = narrowed(f, { [field]: fromDraft(fields.find((x) => x.field === field) ?? f, d) });
    if (Array.isArray(next[f.field])) next[f.field] = (next[f.field] as unknown[]).filter((v) => allowed?.some((c) => String(c) === String(v)));
    if (typeof next[f.field] === "string" && next[f.field] !== "" && !allowed?.some((c) => String(c) === next[f.field])) next[f.field] = "";
  }
  return next;
}

/** A choice field's choices as its `choicesBy` sibling narrows them (operators by the field a condition tests). */
const narrowed = (f: FormFieldInfo, siblings: Record<string, unknown>) => (f.spec ? choicesFor(f.spec, f.choices, siblings) : f.choices);

/** A form's values with every nested `inherit` field set from the form around it (kernel `withInherited`). */
export const withInherited = (fields: readonly FormFieldInfo[], data: Record<string, unknown>, context: Record<string, unknown> = {}) =>
  inheritInto(fields.flatMap((f) => (f.spec ? [{ field: f.field, spec: f.spec }] : [])), data, context);
/** A list's rows as one field each: an object row edits its fields, a plain one its value. */
function itemField(v: ValidatorJSON): FormFieldInfo | null {
  const spec: FieldSpec = { fieldType: v, optional: false };
  const widget = widgetOf(spec);
  return widget ? { field: "item", label: "", widget, required: true, spec, choices: literalChoices(v), labels: choiceLabels(v), descriptions: choiceDescriptions(coreOf(v)) } : null;
}

/** A draft as the value it writes, or undefined when it is empty. `siblings`: the object it sits in, for a variant. */
export function fromDraft(f: FormFieldInfo, d: Draft, siblings: Record<string, unknown> = {}): unknown {
  const t = typeOf(f);
  switch (f.widget) {
    case "bool": return d === true;
    case "tristate": return d === "yes" ? true : d === "no" ? false : undefined;
    case "number": return d === "" || d === undefined ? undefined : Number(d);
    case "money": return d === "" || d === undefined ? undefined : Math.round(Number(d) * 100);
    case "percent": return d === "" || d === undefined ? undefined : Number(d) / 100;
    case "time": return typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d) ? Date.parse(`${d}T00:00:00Z`) : undefined;
    case "choice": return d === "" || d === undefined ? undefined : f.choices?.find((c) => String(c) === d) ?? d;
    case "object": return t?.type === "object" ? objectValue(t, isRecord(d) ? d : {}) : undefined;
    case "variant": {
      const shape = f.spec?.fieldType.type === "variant" ? caseOf(f.spec.fieldType, siblings) : null;
      return shape ? objectValue(shape, isRecord(d) ? d : {}) : undefined;
    }
    case "list": {
      if (t?.type !== "array" || !Array.isArray(d)) return undefined;
      const item = itemField(t.value);
      const rows = item ? d.map((x) => fromDraft(item, x)).filter((x) => x !== undefined) : [];
      return rows.length || f.required ? rows : undefined;
    }
    default: return d === "" || d === undefined ? undefined : d;
  }
}
/** A nested object's draft as its value: each field that isn't empty, a variant after the sibling that picks it. */
function objectValue(o: ObjectValidator, d: Drafts): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  const fields = fieldsOfObject(o);
  for (const f of fields) if (f.widget !== "variant") { const v = fromDraft(f, d[f.field]); if (v !== undefined) out[f.field] = v; }
  for (const f of fields) if (f.widget === "variant") { const v = fromDraft(f, d[f.field], out); if (v !== undefined) out[f.field] = v; }
  return Object.keys(out).length ? out : undefined;
}

/**
 * The fields of a form, each drawn by its widget. `context` holds values the form doesn't show (a fixed one, the doc
 * an update edits), so a variant whose sibling isn't a field here still shows its case.
 */
export function FieldsEditor({ fields, values, onChange, context = {}, idPrefix }: { fields: readonly FormFieldInfo[]; values: Drafts; onChange: (field: string, d: Draft) => void; context?: Record<string, unknown>; idPrefix: string }) {
  const around = useContext(AroundCtx);
  // The values a variant reads its sibling from: what the form holds now, else what it doesn't show.
  const current: Record<string, unknown> = { ...context };
  for (const f of fields) if (f.widget !== "variant") { const v = fromDraft(f, values[f.field]); if (v !== undefined) current[f.field] = v; else delete current[f.field]; }
  // An `inherit` field holds the form around it's value, and isn't shown (a row's plan is the assignment's).
  for (const f of fields) { const v = inherited(f, around); if (v !== undefined) current[f.field] = v; }
  const refs: Record<string, RefValidator> = { ...around.refs };
  for (const f of fields) { const t = typeOf(f); if (t?.type === "ref") refs[f.field] = t; }
  const here: Around = { values: { ...around.values, ...current }, refs };
  return (
    <AroundCtx.Provider value={here}>
      {fields.filter((f) => inherited(f, around) === undefined).map((f) => <FieldRow key={f.field} f={f} value={values[f.field]} onChange={(d) => onChange(f.field, d)} siblings={current} id={`${idPrefix}-${f.field}`} />)}
    </AroundCtx.Provider>
  );
}

/**
 * A placeholder as its input shows it: a text over the docs ref fields name, here or in the forms around it
 * (`"Plan: {$ruleKey.config.rate|percent}"`), each read as the person may read it; nothing when every value is empty.
 */
function usePlaceholder(text: string | null | undefined): string | undefined {
  const env = useContext(Env);
  const around = useContext(AroundCtx);
  const marks = text ? [...text.matchAll(/\{\$([a-zA-Z][a-zA-Z0-9]*)\.([a-zA-Z][a-zA-Z0-9_]*(?:\.[a-zA-Z][a-zA-Z0-9_]*)?)(?:\|[a-zA-Z]+)?\}/g)] : [];
  const asks = marks.flatMap(([, bind, path]) => { const ref = around.refs[bind], key = around.values[bind]; return ref && typeof key === "string" && key ? [{ bind, path, to: ref.to, collection: ref.collection, key }] : []; });
  const values = useQuery(api.modules.refValues, asks.length ? { module: env.module, asks: asks.map(({ to, collection, key, path }) => ({ to, ...(collection ? { collection } : {}), key, field: path })) } : "skip");
  if (!text) return undefined;
  if (!marks.length) return text;
  const binds: Record<string, unknown> = {};
  asks.forEach((a, i) => {
    const [first, second] = a.path.split(".");
    const v = values?.[i] ?? null;
    const doc = (binds[a.bind] as { data: Record<string, unknown> } | undefined) ?? { key: a.key, version: 0, owner: null, data: {} as Record<string, unknown> };
    if (second === undefined) doc.data[first] = v; else doc.data[first] = { ...((doc.data[first] as Record<string, unknown> | undefined) ?? {}), [second]: v };
    binds[a.bind] = doc;
  });
  return renderFilled(text, { ...(env.text ?? { members: new Map(), currency: "USD" }), binds }) || undefined;
}

function FieldRow({ f: given, value, onChange, siblings, id }: { f: FormFieldInfo; value: Draft; onChange: (d: Draft) => void; siblings: Record<string, unknown>; id: string }) {
  const placeholder = usePlaceholder(given.placeholder);
  const choices = given.spec?.choicesBy ? narrowed(given, siblings) : given.choices;
  let f = placeholder === (given.placeholder ?? undefined) && choices === given.choices ? given : { ...given, placeholder: placeholder ?? null, choices };
  const by = f.spec?.choicesBy;
  const labels = by?.labels?.[String(siblings[by.sibling])];
  if (labels) f = { ...f, labels };
  const type = typeOf(f);
  if (f.widget === "list" && type?.type === "array" && choices && f.spec?.choicesBy) {
    const item: ValidatorJSON = { type: "union", value: choices.map((value) => ({ type: "literal", value })), labels: f.labels ?? undefined };
    f = { ...f, spec: { ...f.spec, fieldType: { ...type, value: item } } };
  }
  const inline = f.widget === "bool";
  const block = f.widget === "list" || f.widget === "object" || f.widget === "variant";
  if (f.widget === "variant") {
    const shape = f.spec?.fieldType.type === "variant" ? caseOf(f.spec.fieldType, siblings) : null;
    if (!shape) return null;
  }
  const control = <Control f={f} value={value} onChange={onChange} siblings={siblings} id={id} />;
  if (block) {
    return (
      <fieldset className="col-span-full min-w-0 space-y-2 border border-border/70 p-3">
        <legend className={cn(labelCls, "px-1")}>{f.label}</legend>
        {f.help && <p className="text-xs text-muted-foreground">{f.help}</p>}
        {control}
      </fieldset>
    );
  }
  return (
    <div className={cn("space-y-1", inline && "flex items-center gap-2 space-y-0")}>
      <label htmlFor={id} className={labelCls}>{f.label}</label>
      {control}
      {f.help && !inline && <p className="text-xs text-muted-foreground">{f.help}</p>}
    </div>
  );
}

function Control({ f, value, onChange, siblings, id }: { f: FormFieldInfo; value: Draft; onChange: (d: Draft) => void; siblings: Record<string, unknown>; id: string }) {
  const env = useContext(Env);
  const text = typeof value === "string" ? value : "";
  const t = typeOf(f);
  switch (f.widget) {
    case "bool": return <input id={id} type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} />;
    case "tristate": return <SelectField aria-label={f.label} className="w-full" size="default" value={text} onValueChange={onChange} options={[{ value: "", label: "Not set" }, { value: "yes", label: "Yes" }, { value: "no", label: "No" }]} />;
    case "textarea": return <><textarea id={id} className={cn(input, "h-24")} maxLength={maxOf(t)} placeholder={f.placeholder ?? undefined} value={text} onChange={(e) => onChange(e.target.value)} /><Counter t={t} text={text} /></>;
    case "date": case "time": return <DateInput value={text} onChange={onChange} className="w-full" {...(f.placeholder ? { placeholder: f.placeholder } : {})} />;
    case "choice":
      // Choices that say what each is (a rule's type) show as a list of options with their lines, not a select.
      if (f.descriptions) return <ChoiceList f={f} id={id} value={text} onChange={onChange} />;
      return <SelectField aria-label={f.label} className="w-full" size="default" value={text} onValueChange={onChange}
        options={[{ value: "", label: f.required ? "Choose…" : "None", disabled: f.required }, ...(f.choices ?? []).map((c) => ({ value: String(c), label: f.labels?.[String(c)] ?? human(String(c)) }))]} />;
    case "user": return <MemberPicker id={id} label={f.label} value={text} onChange={onChange} required={f.required} only={f.choices ? f.choices.map(String) : undefined} subs={f.descriptions ?? undefined} badges={f.badges ?? undefined} />;
    case "call": return <CallPicker id={id} value={text} onChange={onChange} required={f.required} label={f.label} />;
    case "ref": return t?.type === "ref" ? <RefPicker id={id} target={t} value={text} onChange={onChange} required={f.required} label={f.label} parent={t.parent !== undefined ? String(siblings[t.parent] ?? "") : undefined} company={t.company !== undefined && typeof siblings[t.company] === "string" ? siblings[t.company] as string : undefined} /> : null;
    case "file": return t?.type === "file" ? <FilePicker id={id} spec={t} value={text} onChange={onChange} label={f.label} /> : null;
    case "object": return t?.type === "object" ? <ObjectEditor o={t} value={isRecord(value) ? value : {}} onChange={onChange} id={id} at={nestedOf(f)} /> : null;
    case "variant": {
      const shape = f.spec?.fieldType.type === "variant" ? caseOf(f.spec.fieldType, siblings) : null;
      return shape ? <ObjectEditor key={String(siblings[f.spec!.fieldType.type === "variant" ? f.spec!.fieldType.variantOf : ""])} o={shape} value={isRecord(value) ? value : {}} onChange={onChange} id={id} at={nestedOf(f)} /> : null;
    }
    // A list of text with suggestions: several values picked from the ones found (and any other typed), as chips.
    case "list": if (t?.type === "array" && coreOf(t.value).type === "string" && f.spec?.suggest && f.collection) return <MultiPick id={id} collection={f.collection} field={f.path ?? f.field} label={f.label} values={Array.isArray(value) ? value.map(String) : []} onChange={onChange} dealField={siblingDeal(f.spec, siblings)} source={sourceOf(f.spec)} />;
      return t?.type === "array" ? <ListEditor item={t.value} rows={Array.isArray(value) ? value : []} onChange={onChange} id={id} label={f.label} at={nestedOf(f)} siblings={siblings} /> : null;
    default: {
      const numeric = f.widget === "number" || f.widget === "money" || f.widget === "percent";
      const field = <input id={id} className={input} type={numeric ? "number" : "text"} maxLength={numeric ? undefined : maxOf(t)} placeholder={f.placeholder ?? undefined}
        step={f.widget === "money" ? "0.01" : f.widget === "number" || f.widget === "percent" ? "any" : undefined} value={text} onChange={(e) => onChange(e.target.value)} />;
      if (!numeric && f.spec?.suggest && f.collection) return <><Suggest id={id} collection={f.collection} field={f.path ?? f.field} label={f.label} value={text} onChange={onChange} dealField={siblingDeal(f.spec, siblings)} source={sourceOf(f.spec)}>{field}</Suggest><Counter t={t} text={text} /></>;
      return <>{field}{!numeric && <Counter t={t} text={text} />}</>;
    }
  }
}

/** A choice whose options say what each is: one radio per option, its label and the line under it. */
function ChoiceList({ f, id, value, onChange }: { f: FormFieldInfo; id: string; value: string; onChange: (d: Draft) => void }) {
  const options = [...(f.required ? [] : [{ value: "", label: "None", line: "" }]), ...(f.choices ?? []).map((c) => ({ value: String(c), label: f.labels?.[String(c)] ?? human(String(c)), line: f.descriptions?.[String(c)] ?? "" }))];
  return (
    <div role="radiogroup" aria-label={f.label} id={id} className="grid gap-1 sm:grid-cols-2">
      {options.map((o) => (
        <label key={o.value} className={cn("flex cursor-pointer items-start gap-2 border px-2 py-1.5 text-sm", value === o.value ? "border-foreground bg-muted/40" : "border-border hover:bg-muted/30")}>
          <input type="radio" className="mt-1" name={id} value={o.value} checked={value === o.value} onChange={() => onChange(o.value)} />
          <span className="min-w-0"><span className="block font-medium">{o.label}</span>{o.line && <span className="block text-xs text-muted-foreground">{o.line}</span>}</span>
        </label>
      ))}
    </div>
  );
}

/** A text field's most characters (`maxLength`), or none. */
const maxOf = (t: ValidatorJSON | null) => (t?.type === "string" ? t.maxLength : undefined);
/** How many characters a text with a `maxLength` has left, once it is past four fifths of it. */
function Counter({ t, text }: { t: ValidatorJSON | null; text: string }) {
  const max = maxOf(t);
  if (max === undefined || text.length < max * 0.8) return null;
  return <p className={cn("text-right text-xs tabular-nums", text.length >= max ? "text-destructive" : "text-muted-foreground")}>{text.length} / {max}</p>;
}

/**
 * A text input that offers the values the field already holds in the docs the person reads (`suggest`), most used
 * first, as they type: an activity's kind written the way the team writes it. Any other text still goes.
 */
/** Where a field's suggestions come from, as the list under it names it: Canon's deals, or the field's own docs. */
const sourceOf = (spec: FieldSpec): string => (spec.suggest && spec.suggest !== true && spec.suggest.deals !== undefined ? "Values on deals" : "Used before");

function Suggest({ id, collection, field, label, value, onChange, children, dealField, source }: { id: string; collection: string; field: string; label: string; value: string; onChange: (d: Draft) => void; children: ReactNode; dealField?: string; source: string }) {
  const env = useContext(Env);
  const [focused, setFocused] = useState(false);
  const options = useQuery(api.modules.suggest, focused ? { module: env.module, collection, field, search: value, ...(dealField ? { dealField } : {}) } : "skip");
  const shown = (options ?? []).filter((o) => o !== value);
  return (
    <div className="relative" onFocus={() => setFocused(true)} onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(false); }}>
      {children}
      {focused && shown.length > 0 && (
        <ul role="listbox" aria-label={`${source} for ${label.toLowerCase()}`} className="absolute top-full right-0 left-0 z-20 mt-1 max-h-48 overflow-y-auto border border-border bg-popover py-1 text-sm shadow-sm">
          <li role="presentation" className="px-2 pt-1 pb-0.5 text-[11px] font-medium text-muted-foreground uppercase">{source}</li>
          {shown.map((o) => <li key={o}><button type="button" role="option" aria-selected={false} className="w-full px-2 py-1 text-left hover:bg-muted" onMouseDown={(e) => e.preventDefault()} onClick={() => { onChange(o); setFocused(false); (document.getElementById(id) as HTMLInputElement | null)?.blur(); }}>{o}</button></li>)}
        </ul>
      )}
    </div>
  );
}

/** The deal field a `suggest: { deals: { sibling } }` field's sibling names now, for its suggestions. */
function siblingDeal(spec: FieldSpec, siblings: Record<string, unknown>): string | undefined {
  const how = spec.suggest;
  if (!how || how === true || typeof how.deals === "string") return undefined;
  const v = siblings[how.deals.sibling];
  return typeof v === "string" && v ? v : undefined;
}

/**
 * Several values of a list of text, as chips: picked from the values found (the field's own, or a Canon deal field's
 * across the deals the person sees), most used first, or typed and added with Enter. Each chip removes with its ×.
 */
function MultiPick({ id, collection, field, label, values, onChange, dealField, source }: { id: string; collection: string; field: string; label: string; values: string[]; onChange: (d: Draft) => void; dealField?: string; source: string }) {
  const env = useContext(Env);
  const [q, setQ] = useState("");
  const [focused, setFocused] = useState(false);
  const options = useQuery(api.modules.suggest, focused ? { module: env.module, collection, field, search: q, ...(dealField ? { dealField } : {}) } : "skip");
  const shown = (options ?? []).filter((o) => !values.includes(o));
  const add = (v: string) => { const t = v.trim(); if (t && !values.includes(t)) onChange([...values, t]); setQ(""); };
  return (
    <div className="relative space-y-1.5" onFocus={() => setFocused(true)} onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(false); }}>
      {values.length > 0 && (
        <ul aria-label={label} className="flex flex-wrap gap-1">
          {values.map((v) => <li key={v} className="inline-flex items-center gap-1 border border-border bg-muted px-1.5 py-0.5 text-xs">{v}<button type="button" aria-label={`Remove ${v}`} onClick={() => onChange(values.filter((x) => x !== v))}><X className="size-3" /></button></li>)}
        </ul>
      )}
      <input id={id} className={input} value={q} placeholder={values.length ? "Add another" : "Pick or type a value"} onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(q); } }} />
      {focused && shown.length > 0 && (
        <ul role="listbox" aria-label={`${source} for ${label.toLowerCase()}`} className="absolute top-full right-0 left-0 z-20 mt-1 max-h-48 overflow-y-auto border border-border bg-popover py-1 text-sm shadow-sm">
          <li role="presentation" className="px-2 pt-1 pb-0.5 text-[11px] font-medium text-muted-foreground uppercase">{source}</li>
          {shown.map((o) => <li key={o}><button type="button" role="option" aria-selected={false} className="w-full px-2 py-1 text-left hover:bg-muted" onMouseDown={(e) => e.preventDefault()} onClick={() => add(o)}>{o}</button></li>)}
        </ul>
      )}
    </div>
  );
}

/** A nested object's fields, a variant among them showing the case its sibling picks. */
function ObjectEditor({ o, value, onChange, id, at }: { o: ObjectValidator; value: Drafts; onChange: (d: Draft) => void; id: string; at?: Nested }) {
  const fields = fieldsOfObject(o, at);
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <FieldsEditor fields={fields} values={value} idPrefix={id} onChange={(field, d) => onChange(setField(fields, value, field, d))} />
    </div>
  );
}

/** Rows of a list: each row's fields side by side, with buttons to add, remove and move rows. */
/** `siblings`: the fields beside the list, which a row's own field reads as its siblings (a contact's company). */
function ListEditor({ item, rows, onChange, id, label, at, siblings = {} }: { item: ValidatorJSON; rows: Draft[]; onChange: (d: Draft) => void; id: string; label: string; at?: Nested; siblings?: Record<string, unknown> }) {
  // Drag a row by its handle onto another to put it there (Move up and down still do it from the keyboard).
  const [dragging, setDragging] = useState<number | null>(null);
  const around = useContext(AroundCtx);
  const f = itemField(item);
  if (!f) return null;
  const core = coreOf(item);
  const blank = () => toDraft(f, f.widget === "choice" && f.choices?.length === 1 ? f.choices[0] : undefined);
  const move = (i: number, by: number) => { const next = [...rows]; const [row] = next.splice(i, 1); next.splice(i + by, 0, row); onChange(next); };
  // A row's fields sit at the list's own path: a tier's label suggests the labels every tier holds.
  const cols = core.type === "object" ? fieldsOfObject(core, at) : null;
  const shownCols = cols ? cols.filter((c) => inherited(c, around) === undefined && !["list", "object", "variant"].includes(c.widget)).length : 0;
  return (
    <div className="space-y-2">
      {rows.length === 0 && <p className="text-xs text-muted-foreground">No rows yet.</p>}
      {rows.length > 0 && (
        <ol className="space-y-2">
          {rows.map((row, i) => (
            <li key={i} className={cn("flex flex-wrap items-start gap-2 sm:flex-nowrap", dragging === i && "opacity-50")}
              onDragOver={(e) => { if (dragging !== null) e.preventDefault(); }}
              onDrop={(e) => { e.preventDefault(); if (dragging !== null && dragging !== i) move(dragging, i - dragging); setDragging(null); }}>
              <span draggable aria-hidden title="Drag to reorder" className="cursor-grab pt-1.5 text-muted-foreground active:cursor-grabbing" onDragStart={(e) => { setDragging(i); e.dataTransfer.effectAllowed = "move"; }} onDragEnd={() => setDragging(null)}><GripVertical className="size-3.5" /></span>
              <span className="w-5 pt-1.5 text-right text-xs tabular-nums text-muted-foreground">{i + 1}</span>
              <div className="order-last w-full min-w-0 sm:order-none sm:w-auto sm:flex-1">
                {cols ? (
                  <div className={cn("grid grid-cols-1 gap-2", ["sm:grid-cols-1", "sm:grid-cols-2", "sm:grid-cols-3", "sm:grid-cols-4"][Math.max(1, Math.min(shownCols, 4)) - 1])}>
                    <FieldsEditor fields={cols} values={isRecord(row) ? row : {}} idPrefix={`${id}-${i}`} onChange={(field, d) => { const next = [...rows]; next[i] = setField(cols, isRecord(row) ? row : {}, field, d); onChange(next); }} />
                  </div>
                ) : <Control f={f} value={row} onChange={(d) => { const next = [...rows]; next[i] = d; onChange(next); }} siblings={siblings} id={`${id}-${i}`} />}
              </div>
              <span className="ml-auto flex shrink-0 gap-1 sm:ml-0 sm:pt-5">
                <button type="button" className={btn} aria-label={`Move row ${i + 1} up`} disabled={i === 0} onClick={() => move(i, -1)}><ArrowUp className="size-3" /></button>
                <button type="button" className={btn} aria-label={`Move row ${i + 1} down`} disabled={i === rows.length - 1} onClick={() => move(i, 1)}><ArrowDown className="size-3" /></button>
                <button type="button" className={btn} aria-label={`Remove row ${i + 1}`} onClick={() => onChange(rows.filter((_, k) => k !== i))}><X className="size-3" /></button>
              </span>
            </li>
          ))}
        </ol>
      )}
      <button type="button" className={btn} onClick={() => onChange([...rows, blank()])}><Plus className="size-3" />Add {label ? label.toLowerCase().replace(/s$/, "") : "row"}</button>
    </div>
  );
}

const size = (bytes: number) => (bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1048576).toFixed(1)} MB`);
/**
 * Attach a file (docs/modules.md, "Files"): checked here against the field's types and size, uploaded to Canon's
 * storage, then recorded for the module; the draft holds its id, and the write checks it again on the server.
 */
function FilePicker({ id, spec, value, onChange, label }: { id: string; spec: FileValidator; value: string; onChange: (d: Draft) => void; label: string }) {
  const env = useContext(Env);
  const uploadUrl = useMutation(api.modules.uploadUrl);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mine, setMine] = useState<Record<string, { name: string; bytes: number }>>({});
  const shown = value ? mine[value] ?? env.files?.[value] : undefined;
  async function upload(file: File) {
    setError(null);
    const why = fileFits(spec, { name: file.name, type: file.type, bytes: file.size });
    if (why) return setError(`${file.name} ${why}.`);
    setBusy(true);
    try {
      const { url } = await uploadUrl({ module: env.module });
      // The upload route stores the file and records it as this person's in one step (convex/lib/modules/uploadRoute.ts).
      const res = await fetch(`${url}&${new URLSearchParams({ name: file.name })}`, { method: "POST", headers: { "Content-Type": file.type || "application/octet-stream" }, body: file });
      const added = (await res.json().catch(() => ({ error: `The upload failed (${res.status}).` }))) as { id: string; name: string; bytes: number; error?: string };
      if (!res.ok || added.error) throw new Error(added.error ?? `The upload failed (${res.status}).`);
      setMine((m) => ({ ...m, [added.id]: added }));
      onChange(added.id);
    } catch (e) { setError(getErrorMessage(e)); } finally { setBusy(false); }
  }
  const max = spec.maxBytes ?? FILE_DEFAULT_BYTES;
  return (
    <div className="space-y-1">
      {value ? (
        <p className="flex items-center gap-2 text-sm">
          <Paperclip aria-hidden className="size-3.5 text-muted-foreground" />
          <span className="truncate">{shown ? `${shown.name} · ${size(shown.bytes)}` : "A file"}</span>
          <button type="button" className={btn} aria-label={`Remove ${label}`} onClick={() => onChange("")}><X className="size-3" />Remove</button>
        </p>
      ) : (
        <input id={id} type="file" aria-label={label} disabled={busy} accept={spec.accept?.join(",")} className="block w-full text-xs file:mr-2 file:border file:border-border file:bg-background file:px-2 file:py-1 file:text-xs"
          onChange={(e) => { const file = e.target.files?.[0]; e.target.value = ""; if (file) void upload(file); }} />
      )}
      <p className="text-xs text-muted-foreground">{busy ? "Uploading…" : `${spec.accept?.length ? `${spec.accept.join(", ")}, ` : ""}up to ${size(max)}.`}</p>
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    </div>
  );
}

/**
 * A member picked from the workspace's, searched by name, under Active and then Inactive (members who have left);
 * with `only` (a field's `options`), only those members: the reps not yet on a plan.
 */
function MemberPicker({ id, label, value, onChange, required, only, subs, badges }: { id: string; label: string; value: string; onChange: (d: Draft) => void; required: boolean; only?: readonly string[]; subs?: Record<string, string>; badges?: Record<string, string> }) {
  const env = useContext(Env);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const needle = search.trim().toLowerCase();
  const allowed = only ? new Set(only) : null;
  const sections = [{ label: "Active", members: env.members }, { label: "Inactive", members: env.inactive ?? [] }]
    .map((x) => ({ ...x, members: x.members.filter((m) => (!allowed || allowed.has(m.id)) && (!needle || m.name.toLowerCase().includes(needle))) })).filter((x) => x.members.length);
  const shown = value ? [...env.members, ...(env.inactive ?? [])].find((m) => m.id === value)?.name ?? value : "";
  return (
    <Popover open={open} onOpenChange={(o) => { setOpen(o); if (!o) setSearch(""); }}>
      <PopoverTrigger asChild>
        <button id={id} type="button" aria-label={label} className={cn(input, "flex items-center justify-between text-left", !value && "text-muted-foreground")}>
          <span className="truncate">{shown || "Pick a member"}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-80 rounded-none p-2" align="start">
        <input autoFocus className={input} placeholder="Search members" value={search} onChange={(e) => setSearch(e.target.value)} aria-label={`Search ${label}`} />
        <div className="mt-2 max-h-60 overflow-y-auto text-sm" role="listbox" aria-label={label}>
          {!required && value && <button type="button" className="w-full px-2 py-1 text-left text-muted-foreground hover:bg-muted" onClick={() => { onChange(""); setOpen(false); }}>Nobody</button>}
          {!sections.length && <p className="px-2 py-1 text-xs text-muted-foreground">{allowed && !allowed.size ? "No one is left to pick." : "No member matches."}</p>}
          {sections.map((sec) => (
            <div key={sec.label} role="group" aria-label={sec.label}>
              <p className="px-2 pt-2 pb-1 text-[11px] font-medium text-muted-foreground uppercase">{sec.label}</p>
              {sec.members.map((m) => (
                <button key={m.id} type="button" role="option" aria-selected={m.id === value} className={cn("flex w-full items-start justify-between gap-2 px-2 py-1 text-left hover:bg-muted", m.id === value && "font-medium")}
                  onClick={() => { onChange(m.id); setOpen(false); }}>
                  <span className="min-w-0">
                    <span className="block truncate">{m.name}</span>
                    {subs?.[m.id] && <span className="block truncate text-xs font-normal text-muted-foreground">{subs[m.id]}</span>}
                  </span>
                  {badges?.[m.id] && <span className="shrink-0 border border-border px-1.5 text-[11px] font-normal text-muted-foreground">{badges[m.id]}</span>}
                </button>
              ))}
            </div>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** A picker's prompt before a pick: "Pick a deal", or a module doc by its collection's label, "Pick a team group". */
const pickPrompt = (target: RefValidator, env: FormEnv) => {
  const noun = target.to === "doc" ? (env.collectionLabels?.[target.collection ?? ""] ?? human((target.collection ?? "doc").replace(/s$/, ""))) : target.to === "companies" ? "company" : target.to === "people" ? "person" : target.to.replace(/s$/, "");
  return `Pick ${/^[aeiou]/i.test(noun) ? "an" : "a"} ${noun.toLowerCase()}`;
};

/** Pick a Canon call (a `call` widget): the calls the person reads, newest first, searched by title; its id is the value. */
function CallPicker({ id, value, onChange, required, label }: { id: string; value: string; onChange: (d: Draft) => void; required: boolean; label: string }) {
  const env = useContext(Env);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  // The call it holds comes first, so its title shows before the picker opens.
  const options = useQuery(api.modules.pickCall, { module: env.module, search: open ? search : "", ...(value ? { current: value } : {}) });
  const shown = value ? options?.find((o) => o.id === value)?.label ?? (options ? "A call you can't see" : "…") : "";
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button id={id} type="button" aria-label={label} className={cn(input, "flex items-center justify-between text-left", !value && "text-muted-foreground")}>
          <span className="truncate">{shown || "Pick a call"}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-80 rounded-none p-2" align="start">
        <input autoFocus className={input} placeholder="Search calls" value={search} onChange={(e) => setSearch(e.target.value)} aria-label={`Search ${label}`} />
        <ul className="mt-2 max-h-60 overflow-y-auto text-sm" role="listbox">
          {!required && value && <li><button type="button" className="w-full px-2 py-1 text-left text-muted-foreground hover:bg-muted" onClick={() => { onChange(""); setOpen(false); }}>None</button></li>}
          {options === undefined && <li className="px-2 py-1 text-xs text-muted-foreground">Searching…</li>}
          {options?.length === 0 && <li className="px-2 py-1 text-xs text-muted-foreground">No calls you can see match.</li>}
          {options?.map((o) => (
            <li key={o.id}>
              <button type="button" role="option" aria-selected={o.id === value} className={cn("w-full px-2 py-1 text-left hover:bg-muted", o.id === value && "font-medium")}
                onClick={() => { onChange(o.id); setOpen(false); }}>{o.label}</button>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

/**
 * A company or person picker's options: the record service's, searched as the person types (a pause first), only the
 * ones they see; a company's people when `company` names one. Undefined while it reads.
 */
function useRecordPicks(on: boolean, module: string, to: "companies" | "people", search: string, company: string | undefined) {
  const read = useAction(api.modules.records);
  const [got, setGot] = useState<{ key: string; rows: Array<{ id: string; label: string; doNotContact?: boolean }> } | null>(null);
  const key = `${to}|${company ?? ""}|${search}`;
  useEffect(() => {
    if (!on) return;
    let live = true;
    const wait = setTimeout(() => {
      read({ module, to, search, ...(company ? { company } : {}) }).then((rows) => { if (live) setGot({ key, rows }); }, () => { if (live) setGot({ key, rows: [] }); });
    }, 200);
    return () => { live = false; clearTimeout(wait); };
  }, [on, key, module, read]); // eslint-disable-line react-hooks/exhaustive-deps
  return on && got?.key === key ? got.rows : undefined;
}

/** Pick a deal, team, company, person or module doc: searched as the person types, from what they may read. */
/** `parent`: for a ref that sits under a parent, the key its sibling holds: the picker offers only that doc's set. `company`: a people ref's company, once one is picked. */
function RefPicker({ id, target, value, onChange, required, label, parent, company }: { id: string; target: RefValidator; value: string; onChange: (d: Draft) => void; required: boolean; label: string; parent?: string; company?: string }) {
  const env = useContext(Env);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [picked, setPicked] = useState<Record<string, string>>({});
  const record = target.to === "companies" || target.to === "people";
  const docs = useQuery(api.modules.pick, open && !record ? { module: env.module, to: target.to, ...(target.collection ? { collection: target.collection } : {}), search, ...(parent !== undefined ? { parent } : {}) } : "skip");
  const records = useRecordPicks(open && record, env.module, target.to === "people" ? "people" : "companies", search, company);
  const options = record ? records : docs;
  const shown = value ? picked[value] ?? env.refLabels[value] ?? (target.to === "users" ? env.members.find((m) => m.id === value)?.name : undefined) ?? value : "";
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button id={id} type="button" aria-label={label} className={cn(input, "flex items-center justify-between text-left", !value && "text-muted-foreground")}>
          <span className="truncate">{shown || pickPrompt(target, env)}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-80 rounded-none p-2" align="start">
        <input autoFocus className={input} placeholder="Search" value={search} onChange={(e) => setSearch(e.target.value)} aria-label={`Search ${label}`} />
        <ul className="mt-2 max-h-60 overflow-y-auto text-sm" role="listbox">
          {!required && value && <li><button type="button" className="w-full px-2 py-1 text-left text-muted-foreground hover:bg-muted" onClick={() => { onChange(""); setOpen(false); }}>None</button></li>}
          {options === undefined && <li className="px-2 py-1 text-xs text-muted-foreground">Searching…</li>}
          {options?.length === 0 && <li className="px-2 py-1 text-xs text-muted-foreground">{parent === "" ? "Pick what it belongs to first." : "Nothing you can see matches."}</li>}
          {options?.map((o) => (
            <li key={o.id}>
              <button type="button" role="option" aria-selected={o.id === value} className={cn("w-full px-2 py-1 text-left hover:bg-muted", o.id === value && "font-medium")}
                onClick={() => { setPicked((p) => ({ ...p, [o.id]: o.label })); onChange(o.id); setOpen(false); }}>{o.label}{"doNotContact" in o && o.doNotContact === true && <span className="ml-2 text-xs text-muted-foreground">Do not contact</span>}</button>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
