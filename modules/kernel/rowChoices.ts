import type { RowChoices } from "./manifest.ts";
import { choiceLabels, coreOf, literalChoices, type FieldSpec } from "./schema.ts";
import { renderText, valueAt, type Doc, type TextScope } from "./text.ts";

export type ChoiceRow = { key: string; title: string; options: Array<{ value: string; label: string }>; initial: string };

export function rowChoicesOf(config: RowChoices, spec: FieldSpec | null, rows: readonly Doc[], scope: TextScope): ChoiceRow[] {
  const rec = spec ? coreOf(spec.fieldType) : null;
  const type = rec?.type === "record" ? coreOf(rec.values.fieldType) : null;
  const allowed = (type ? literalChoices(type) ?? [] : []).map(String);
  const labels = type ? choiceLabels(type) : null;
  return rows.map((row) => {
    const text = { ...scope, row };
    const own = config.options;
    const list = own ? valueAt(row, own.list) : null;
    const options = own ? (Array.isArray(list) ? list : []).flatMap((raw, i) => {
      const item: Doc = { key: String(i), version: 0, owner: null, data: { ...(raw && typeof raw === "object" ? raw : { value: raw }), n: i + 1 } };
      const value = String(own.value ? valueAt(item, own.value) ?? "" : i);
      if (!allowed.includes(value)) return [];
      return [{ value, label: renderText(own.label, { ...text, binds: { ...scope.binds, item } }) || value }];
    }) : allowed.map((value) => ({ value, label: labels?.[value] ?? value.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase()).replace(/ ([A-Z])/g, (_m, c: string) => ` ${c.toLowerCase()}`) }));
    const unique = options.filter((o, i) => options.findIndex((p) => p.value === o.value) === i);
    const initial = config.initial ? String(valueAt(row, config.initial) ?? "") : "";
    return { key: String(config.value ? valueAt(row, config.value) ?? "" : row.key), title: renderText(config.title, text), options: unique, initial: unique.some((o) => o.value === initial) ? initial : unique[0]?.value ?? "" };
  });
}
