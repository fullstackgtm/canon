"use client";

import { z } from "zod";
import { useId, useState, type FormEvent } from "react";
import { activityComposerKinds, BLOCKS, pageKind, parseRecordProps, type RecordBlock, type RecordProps } from "../../../../recipes/blocks";

type Property = { type?: string; enum?: string[]; items?: Property; properties?: Record<string, Property>; minimum?: number; maximum?: number; maxLength?: number; anyOf?: { const?: number }[] };
const input = "block w-full border border-border bg-background px-2 py-1 text-sm";

function readProperty(schema: Property, data: FormData, key: string): unknown {
  if (schema.type === "boolean") {
    const choice = data.get(key);
    return typeof choice === "string" && choice !== "" ? choice === "true" : undefined;
  }
  if (schema.type === "object") {
    const fields = Object.entries(schema.properties ?? {}).map(([name, value]) => [name, readProperty(value, data, `${key}.${name}`)]);
    return fields.some(([, value]) => value !== undefined) ? Object.fromEntries(fields) : undefined;
  }
  const raw = String(data.get(key) ?? "");
  const value = key === "markdown" ? raw : raw.trim();
  if (schema.type === "array") {
    if (schema.items?.enum) {
      const values = data.getAll(key);
      if (key === "composer") return values.includes("") ? undefined : values;
      return values.length ? values : undefined;
    }
    return value ? value.split(",").map((part) => part.trim()).filter(Boolean) : undefined;
  }
  return value ? schema.type === "integer" || schema.type === "number" || schema.anyOf?.every((option) => typeof option.const === "number") ? Number(value) : value : undefined;
}

function PropInput({ name, schema, value, allowed, required }: { name: string; schema: Property; value: unknown; allowed?: string[]; required?: boolean }) {
  const id = useId();
  const label = name.split(".").at(-1)!.replace(/^./, (c) => c.toUpperCase());
  if (schema.type === "object") return <fieldset className="grid gap-2 border border-border p-2">
    <legend className="text-xs">{label}</legend>
    {Object.entries(schema.properties ?? {}).map(([key, child]) => <PropInput key={key} name={`${name}.${key}`} schema={child} value={value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined} />)}
  </fieldset>;
  if (schema.type === "boolean") return <label htmlFor={id} className="block text-xs">{label}
    <select id={id} name={name} className={input} defaultValue={String(value ?? "")}>
      <option value="">Default</option><option value="true">Yes</option><option value="false">No</option>
    </select>
  </label>;
  if (name === "markdown") return <label htmlFor={id} className="block text-xs">{label}
    <textarea id={id} name={name} required={required} rows={5} maxLength={schema.maxLength} className={input} defaultValue={String(value ?? "")} />
  </label>;
  if (schema.type === "array" && schema.items?.enum) return <label htmlFor={id} className="block text-xs">{label}
    <select id={id} name={name} multiple size={Math.min(6, (allowed?.length ?? schema.items.enum.length) + (name === "composer" ? 1 : 0))} className={input}
      defaultValue={Array.isArray(value) ? value : name === "composer" ? [""] : []}>
      {name === "composer" && <option value="">Use object defaults</option>}
      {[...new Set([...(Array.isArray(value) ? value as string[] : []), ...(allowed ?? schema.items.enum)])].map((v) => <option key={v} value={v}>{v.replace("kernel.", "")}</option>)}
    </select>
  </label>;
  const choices = schema.enum ?? schema.anyOf?.flatMap((option) => typeof option.const === "number" ? [String(option.const)] : []);
  if (choices?.length) return <label htmlFor={id} className="block text-xs">{label}
    <select id={id} name={name} required={required} className={input} defaultValue={String(value ?? "")}><option value="">Choose…</option>{choices.map((v) => <option key={v}>{v}</option>)}</select>
  </label>;
  const numeric = schema.type === "integer" || schema.type === "number";
  return <label htmlFor={id} className="block text-xs">{label}
    <input id={id} name={name} required={required} type={numeric ? "number" : "text"} min={schema.minimum} max={schema.maximum}
      placeholder={schema.type === "array" ? "Comma-separated names" : undefined} defaultValue={Array.isArray(value) ? value.join(", ") : String(value ?? "")} className={input} />
  </label>;
}

export function RecordBlockSettings({ component, object, value, disabled, onSave, onCancel }: {
  component: RecordBlock; object: string; value?: RecordProps; disabled?: boolean;
  onSave: (value: RecordProps) => void; onCancel?: () => void;
}) {
  const [error, setError] = useState("");
  const kind = pageKind(object);
  const block = BLOCKS[component];
  const schema = z.toJSONSchema(block.settings) as Property & { required?: string[] };
  const entries = Object.entries(schema.properties ?? {});
  const allowed = block.actions.filter((a) => a.object === kind).map((a) => a.id);
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      const form = new FormData(event.currentTarget);
      const props = Object.fromEntries(entries.flatMap(([name, property]) => {
        const value = readProperty(property, form, name);
        return value === undefined ? [] : [[name, value]];
      }));
      if (component === "actionBar" && !("actions" in props)) props.actions = [];
      onSave(parseRecordProps(component, props, kind));
      setError("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }
  return <form className="space-y-2 border border-border p-2" onSubmit={submit}>
    <fieldset disabled={disabled} className="space-y-2">
      <legend className="text-xs font-medium">{onCancel ? block.title : "Block settings"}</legend>
      {entries.map(([name, property]) => <PropInput key={name} name={name} schema={property} required={schema.required?.includes(name)}
        value={(value as Record<string, unknown> | undefined)?.[name]}
        allowed={name === "actions" ? allowed : name === "composer" ? [...activityComposerKinds(kind)] : undefined} />)}
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
      <div className="flex gap-2">
        <button type="submit" className="border border-border px-2 py-1 text-xs hover:bg-muted">{onCancel ? "Add section" : "Apply settings"}</button>
        {onCancel && <button type="button" className="px-2 py-1 text-xs" onClick={onCancel}>Cancel</button>}
      </div>
    </fieldset>
  </form>;
}
