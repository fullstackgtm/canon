"use client";

import { useState, type ReactNode } from "react";
import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import type { ShareDoc, SharePayload, VisitorForm } from "../../../convex/lib/modules/shares";
import type { ActionRef, FormExpr, Node, SHARE_COMPONENTS } from "../../../modules/kernel/manifest";
import type { VisitorWrite, VisitorUploadTarget } from "../../../modules/kernel/visit";
import { coreOf } from "../../../modules/kernel/schema";
import { nodeShows } from "../../../modules/kernel/document";
import { fillPath, renderText, rowWhenHolds, valueAt, type Doc, type TextScope } from "../../../modules/kernel/text";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

const button = "inline-flex border border-border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50";
const docOf = (d: ShareDoc): Doc => ({ ...d, owner: null });
export type VisitorRunner = (input: VisitorWrite) => Promise<void>;
export type VisitorUploader = (target: VisitorUploadTarget, file: File) => Promise<{ id: string; name: string; type: string; bytes: number }>;
type VisitorCtx = { payload: SharePayload; text: TextScope; navigate: (path: string) => void; run?: VisitorRunner; upload?: VisitorUploader; download?: (id: string) => Promise<void> };
type Allowed = (typeof SHARE_COMPONENTS)[number];
type Of<C extends Allowed> = Extract<Node, { c: C }>;
const rows = (ctx: VisitorCtx, from: string) => {
  const value = ctx.payload.data[from];
  return Array.isArray(value) ? value.map(docOf) : [];
};
const rowText = (ctx: VisitorCtx, from: string, row: Doc): TextScope => ({ ...ctx.text, row, rowLabels: ctx.payload.labels[from], rowFormats: ctx.payload.formats[from] });

function sharePath(path: string, payload: SharePayload): boolean {
  if (/^(?:[/\\]|[a-z][a-z0-9+.-]*:)/i.test(path) || /[\x00-\x20]/.test(path)) return false;
  const parts = path.split("?")[0].split("/");
  try { if (parts.some((p) => { const decoded = decodeURIComponent(p); return decoded === "." || decoded === ".." || /[/\\\x00-\x20\x7f]/.test(decoded); })) return false; } catch { return false; }
  return !parts.some((p) => p === "." || p === "..") && payload.pages.some((p) => {
    const pattern = p.path.split("/");
    return pattern.length === parts.length && pattern.every((part, i) => part.startsWith(":") || part === parts[i]);
  });
}

function sharedHttps(value: unknown): string | undefined {
  if (typeof value !== "string" || /[\x00-\x20\x7f]/.test(value)) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : undefined;
  } catch { return undefined; }
}

function formValue(expr: FormExpr, ctx: VisitorCtx, row?: Doc): unknown {
  if (expr === null || typeof expr !== "object") return expr;
  if ("bind" in expr) return valueAt(ctx.payload.data[expr.bind], expr.field);
  if ("row" in expr) return valueAt(row, expr.row);
  if ("today" in expr) return new Date().toISOString().slice(0, 10);
  if ("query" in expr) return typeof window === "undefined" ? expr.default : new URLSearchParams(window.location.search).get(expr.query) ?? expr.default;
  if ("route" in expr) {
    if (typeof window === "undefined") return undefined;
    const parts = window.location.pathname.split("/").slice(4);
    const index = ctx.payload.page.path.split("/").indexOf(`:${expr.route}`);
    return index < 0 ? undefined : parts[index];
  }
  return undefined;
}

type WriteAction = Extract<ActionRef, { op: string } | { transition: string }>;

function VisitorWriteAction({ action, ctx, row }: { action: WriteAction; ctx: VisitorCtx; row?: Doc }) {
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState<string>();
  const [draft, setDraft] = useState<{ values: Record<string, unknown>; fixed: Record<string, unknown>; target?: Pick<ShareDoc, "key" | "version"> }>({ values: {}, fixed: {} });
  const values = draft.values;
  const form: VisitorForm | undefined = "op" in action ? ctx.payload.writes.ops[action.op] : ctx.payload.writes.transitions[`${action.machine}.${action.transition}`];
  const chosenKey = action.key === undefined ? undefined : formValue(action.key, ctx, row);
  const bound = action.target ? ctx.payload.data[action.target] : typeof chosenKey === "string" ? Object.values(ctx.payload.data).flatMap((v) => Array.isArray(v) ? v : v ? [v] : []).find((v) => v.key === chosenKey) : row;
  const target = bound && !Array.isArray(bound) ? bound : undefined;
  const fixed = Object.fromEntries(Object.entries(action.fixed ?? {}).filter(([f]) => Object.hasOwn(form?.fields ?? {}, f)).map(([f, expr]) => [f, formValue(expr, ctx, row)]));
  const asks = Object.entries(form?.fields ?? {}).filter(([f]) => !Object.hasOwn(fixed, f));
  const words = { ...ctx.text, ...(row ? { row } : {}) };
  const label = renderText(action.label ?? form?.label ?? "Save", words);
  function show() {
    if (!form) return;
    const initial = Object.fromEntries(asks.map(([f, sp]) => {
      const expr = action.initial?.[f];
      const value = expr && typeof expr === "object" && "text" in expr ? renderText(expr.text, words) : expr !== undefined ? formValue(expr, ctx, row) : target?.data[f];
      const type = coreOf(sp.fieldType).type;
      return [f, value ?? (type === "boolean" || sp.fieldType.type === "literal" && typeof sp.fieldType.value === "boolean" ? false : "")];
    }));
    setDraft({ values: initial, fixed, ...(target ? { target: { key: target.key, version: target.version } } : {}) }); setError(undefined); setOpen(true);
  }
  async function submit() {
    if (!form || !ctx.run) return;
    setBusy(true); setError(undefined);
    try {
      const data = { ...values, ...draft.fixed }, edited = draft.target;
      for (const [f, sp] of Object.entries(form.fields)) {
        const type = coreOf(sp.fieldType).type;
        if (data[f] === "" && sp.optional) { delete data[f]; continue; }
        if (type === "file" && data[f] instanceof File) {
          if (!ctx.upload) throw new Error("Uploads are unavailable.");
          const target: VisitorUploadTarget = "op" in action ? { kind: "op", op: action.op, field: f, ...(form.kind === "update" && edited ? { key: edited.key, expect: edited.version } : {}) } : { kind: "transition", machine: action.machine, transition: action.transition, field: f, key: edited!.key, expect: edited!.version };
          const saved = await ctx.upload(target, data[f] as File);
          data[f] = saved.id;
          setDraft((old) => ({ ...old, values: { ...old.values, [f]: saved.id } }));
        }
        if (type === "number") data[f] = Number(data[f]);
        if (["array", "object", "record", "variant"].includes(type) && typeof data[f] === "string") data[f] = JSON.parse(data[f] as string);
      }
      if ("op" in action) {
        if (form.kind === "update" && !edited) throw new Error();
        await ctx.run({ kind: "op", op: action.op, ...(form.kind === "update" ? { key: edited!.key, expect: edited!.version } : {}), data });
      } else {
        if (!edited) throw new Error();
        await ctx.run({ kind: "transition", machine: action.machine, transition: action.transition, key: edited.key, expect: edited.version, args: data });
      }
      setOpen(false);
    } catch (e) { setError(e instanceof Error && e.message ? e.message : "This change could not be saved. Refresh the page and try again."); }
    finally { setBusy(false); }
  }
  return <><button className={button} disabled={!ctx.run || !form} title={!ctx.run ? "Actions are off in preview" : undefined} onClick={show}>{label}</button>{open && form && <div role="dialog" aria-modal="true" aria-label={label} className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"><form className="max-h-[90vh] w-full max-w-lg space-y-4 overflow-auto border border-border bg-background p-6" onSubmit={(event) => { event.preventDefault(); void submit(); }}><h2 className="text-lg font-semibold">{renderText(action.dialog?.title ?? label, words)}</h2>{action.dialog?.description && <p className="text-sm">{renderText(action.dialog.description, words)}</p>}{form.confirm && <p className="text-sm">{renderText(form.confirm, words)}</p>}{asks.map(([f, sp]) => {
    const type = coreOf(sp.fieldType), id = `visitor-${f}`, named = action.fields?.find((x) => x.field === f);
    const docChoices = form.choices?.[f] ?? [];
    const choices = type.type === "union" ? type.value.flatMap((v) => v.type === "literal" ? [v.value] : []) : [];
    const v = values[f], set = (value: unknown) => setDraft((old) => ({ ...old, values: { ...old.values, [f]: value } }));
    return <div key={f} className="space-y-1"><label htmlFor={id} className="block text-sm">{named?.label ?? sp.label ?? f}</label>{type.type === "file" ? <><input id={id} type="file" disabled={busy || !ctx.upload} required={!sp.optional && !v} accept={(type.accept ?? ["image/png", "image/jpeg", "application/pdf"]).join(",")} onChange={(e) => set(e.target.files?.[0] ?? "")} /><p className="text-xs text-muted-foreground">PNG, JPEG or PDF within the field's size limit. Files are not scanned.</p></> : type.type === "boolean" || type.type === "literal" && typeof type.value === "boolean" ? <input id={id} type="checkbox" required={type.type === "literal" && type.value === true} checked={v === true} onChange={(e) => set(e.target.checked)} /> : type.type === "ref" && type.to === "doc" ? <select id={id} className="w-full border border-border bg-background p-2" value={String(v ?? "")} required={!sp.optional} onChange={(e) => set(e.target.value)}><option value="">Choose...</option>{docChoices.map((choice) => <option key={choice.key} value={choice.key}>{choice.label}</option>)}</select> : choices.length ? <select id={id} className="w-full border border-border bg-background p-2" value={String(v ?? "")} required={!sp.optional} onChange={(e) => set(choices.find((choice) => String(choice) === e.target.value) ?? e.target.value)}><option value="">Choose...</option>{choices.map((choice) => <option key={String(choice)} value={String(choice)}>{type.type === "union" ? type.labels?.[String(choice)] ?? String(choice) : String(choice)}</option>)}</select> : <textarea id={id} className="w-full border border-border bg-background p-2" required={!sp.optional} maxLength={type.type === "string" ? Math.min(type.maxLength ?? 5000, 5000) : undefined} value={typeof v === "string" || typeof v === "number" ? String(v) : JSON.stringify(v ?? "")} onChange={(e) => set(e.target.value)} />}</div>;
  })}{error && <p role="alert" className="text-sm text-destructive">{error}</p>}<p className="text-xs text-muted-foreground">Your attribution is unverified unless Canon has verified it. Saving records your browser and IP as Canon's edge reported them for workspace admins.</p><div className="flex gap-2"><button className={button} type="submit" disabled={busy}>{busy ? "Saving..." : renderText(action.dialog?.submit ?? "Save", words)}</button><button className={button} type="button" disabled={busy} onClick={() => setOpen(false)}>Cancel</button></div></form></div>}</>;
}

function VisitorActions({ items, ctx, row }: { items: readonly ActionRef[]; ctx: VisitorCtx; row?: Doc }) {
  return <div className="flex flex-wrap gap-2">{items.map((a, i) => {
    const at = "target" in a && a.target ? ctx.payload.data[a.target] : row;
    if (a.when) {
      if ("page" in a.when) {
        const w = a.when, v = formValue(w.page, ctx, row);
        if ("in" in w && !w.in.includes((v ?? null) as never) || "set" in w && (v !== undefined && v !== null && v !== "") !== w.set) return null;
        if ("gte" in w || "lte" in w) {
          const bound = "gte" in w ? w.gte : w.lte;
          const today = new Date().toISOString().slice(0, 10);
          const to = bound !== null && typeof bound === "object" ? bound.now === "year" ? Number(today.slice(0, 4)) : bound.now === "month" ? today.slice(0, 7) : today : bound;
          const diff = Number.isFinite(Number(v)) && Number.isFinite(Number(to)) ? Number(v) - Number(to) : String(v).localeCompare(String(to));
          if (v === undefined || v === null || v === "" || ("gte" in w ? diff < 0 : diff > 0)) return null;
        }
      } else if (!at || Array.isArray(at) || !rowWhenHolds(a.when, docOf(at), null)) return null;
    }
    if ("navigate" in a) {
      const target = a.target ? ctx.payload.data[a.target] : row;
      const values = target && !Array.isArray(target) ? { ...Object.fromEntries(Object.entries(target.data).map(([k, v]) => [k, String(v)])), key: target.key } : {};
      return <button key={i} className={button} onClick={() => ctx.navigate(fillPath(renderText(a.navigate, { ...ctx.text, ...(row ? { row } : {}) }), values))}>{renderText(a.label, ctx.text)}</button>;
    }
    if ("menu" in a) return <VisitorActions key={i} items={a.items} ctx={ctx} row={row} />;
    if ("op" in a || "transition" in a) return <VisitorWriteAction key={i} action={a} ctx={ctx} row={row} />;
    return <button key={i} className={button} disabled title="This page is read-only">{"label" in a && a.label ? a.label : "Action"}</button>;
  })}</div>;
}

function VisitorTabs({ n, ctx }: { n: Of<"tabs">; ctx: VisitorCtx }) {
  return <Tabs defaultValue="0"><TabsList variant="line">{n.tabs.map((t, i) => <TabsTrigger key={i} value={String(i)}>{renderText(t.label, ctx.text)}</TabsTrigger>)}</TabsList>{n.tabs.map((t, i) => <TabsContent key={i} value={String(i)} className="pt-4"><VisitorNodes nodes={t.body} ctx={ctx} /></TabsContent>)}</Tabs>;
}

function VisitorFile({ id, ctx }: { id: string; ctx: VisitorCtx }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState(false);
  const info = ctx.payload.files[id];
  if (!info) return <span>Unavailable file</span>;
  return <span className="inline-flex flex-col gap-1"><button type="button" className="text-left underline disabled:opacity-50" disabled={!ctx.download || busy} onClick={async () => {
    setBusy(true); setError(false);
    try { await ctx.download?.(id); } catch { setError(true); } finally { setBusy(false); }
  }}>{busy ? "Downloading..." : info.name}</button><span className="text-xs text-muted-foreground">{info.type}, {info.bytes.toLocaleString()} bytes{info.buyer ? ` · ${info.buyer.label} (${info.buyer.verified ? "verified" : "unverified"}) · not scanned` : ""}</span>{error && <span role="alert">This file could not be downloaded.</span>}</span>;
}

function visitorText(value: string, ctx: VisitorCtx, from?: string, row?: Doc): ReactNode {
  const match = /^\{\$([A-Za-z][A-Za-z0-9]*)\.([A-Za-z][A-Za-z0-9_]*)(?:\|[A-Za-z]+)?\}$/.exec(value.trim());
  const bind = match?.[1] === "row" ? from : match?.[1];
  const doc = match?.[1] === "row" ? row : bind ? ctx.payload.data[bind] : undefined;
  if (match && bind && doc && !Array.isArray(doc) && ctx.payload.labels[bind]?.[match[2]]) {
    const label = ctx.payload.labels[bind][match[2]][String(doc.data[match[2]])];
    if (label !== undefined) return label;
  }
  if (match && bind && doc && !Array.isArray(doc) && ctx.payload.formats[bind]?.[match[2]] === "file") {
    const id = doc.data[match[2]];
    return typeof id === "string" ? <VisitorFile id={id} ctx={ctx} /> : "None";
  }
  return renderText(value, from && row ? rowText(ctx, from, row) : ctx.text);
}

const RENDERERS: { [C in Allowed]: (n: Of<C>, ctx: VisitorCtx) => ReactNode } = {
  header: (n, ctx) => <header><h1 className="font-display text-2xl font-semibold">{renderText(n.title, ctx.text)}</h1>{n.subtitle && <p className="mt-2 text-sm text-muted-foreground">{renderText(n.subtitle, ctx.text)}</p>}{n.actions && <VisitorActions items={n.actions} ctx={ctx} />}</header>,
  banner: (n, ctx) => <div role="status" className="border-l-2 border-border bg-muted/40 p-4 text-sm"><p>{renderText(n.text, ctx.text)}</p>{n.list && <ul>{rows(ctx, n.list.from).map((r) => <li key={r.key}>{renderText(n.list!.label, rowText(ctx, n.list!.from, r))}</li>)}</ul>}{n.actions && <VisitorActions items={n.actions} ctx={ctx} />}</div>,
  detail: (n, ctx) => <dl className="grid gap-4 border border-border p-4 text-sm sm:grid-cols-2">{n.items.map((x, i) => <div key={i}><dt className="text-xs text-muted-foreground">{renderText(x.label, ctx.text)}</dt><dd className="mt-1 whitespace-pre-wrap break-words">{visitorText(x.value, ctx) || "None"}</dd></div>)}</dl>,
  kpis: (n, ctx) => <dl className="flex flex-wrap gap-8">{n.items.map((x, i) => {
    const value = "value" in x ? renderText(x.value, ctx.text) : "count" in x ? rows(ctx, x.count).length : rows(ctx, x.total.from).reduce((sum, row) => sum + (Number(valueAt(row, x.total.sum)) || 0), 0);
    return <div key={i}><dt className="text-xs text-muted-foreground">{x.label}</dt><dd className="text-2xl tabular-nums">{value}</dd></div>;
  })}</dl>,
  statusSteps: (n, ctx) => {
    const machine = ctx.payload.machines[n.machine], doc = ctx.payload.data[n.from];
    if (!machine || !doc || Array.isArray(doc)) return null;
    return <ol className="flex flex-wrap gap-3 text-sm">{(n.steps ?? machine.states).map((s) => <li key={s} className={doc.data[machine.field] === s ? "font-semibold" : "text-muted-foreground"} aria-current={doc.data[machine.field] === s ? "step" : undefined}>{s}</li>)}</ol>;
  },
  table: (n, ctx) => {
    const compare = (a: unknown, b: unknown): number => {
      if (a === b) return 0;
      if (a === undefined || a === null) return 1;
      if (b === undefined || b === null) return -1;
      if (typeof a === "number" && typeof b === "number") return a - b;
      return String(a) < String(b) ? -1 : 1;
    };
    const list = rows(ctx, n.from).sort((a, b) => (n.sort ? compare(valueAt(a, n.sort.by), valueAt(b, n.sort.by)) * (n.sort.dir === "desc" ? -1 : 1) : 0) || compare(a.key, b.key));
    if (!list.length) return <p className="text-sm text-muted-foreground">{n.empty ?? "No items"}</p>;
    const groups = new Map<string, { label: string; rows: Doc[] }>();
    const grouping = n.groupBy ?? (n.group ? [{ by: n.group.by, label: `{$row.${n.group.by}}` }] : []);
    for (const row of list) {
      const key = JSON.stringify(grouping.map((g) => valueAt(row, g.by) ?? null));
      const label = grouping.map((g) => renderText(g.label, rowText(ctx, n.from, row))).join(" · ");
      const group = groups.get(key) ?? { label, rows: [] };
      group.rows.push(row); groups.set(key, group);
    }
    return <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr>{n.columns.map((c, i) => <th key={i} className="border-b border-border p-2 font-medium">{renderText(c.label, ctx.text)}</th>)}{n.rowActions?.length ? <th className="p-2">Actions</th> : null}</tr></thead>{[...groups].map(([key, group]) => <tbody key={key}>{grouping.length > 0 && <tr><th colSpan={n.columns.length + (n.rowActions?.length ? 1 : 0)} className="border-b border-border bg-muted/40 p-2">{group.label || "Other steps"}</th></tr>}{group.rows.map((r) => <tr key={r.key}>{n.columns.map((c, i) => {
      const href = c.link && typeof c.link === "object" && "url" in c.link ? sharedHttps(valueAt(r, c.link.url)) : undefined;
      const value = visitorText(c.value, ctx, n.from, r) || c.empty || "";
      return <td key={i} className="border-b border-border p-2">{href ? <a href={href} target="_blank" rel="noopener noreferrer" className="underline">{value || "Open link"}</a> : value}{c.link && typeof c.link === "string" && <VisitorActions items={[{ navigate: c.link, label: "Open" }]} ctx={ctx} row={r} />}</td>;
    })}{n.rowActions?.length ? <td className="border-b border-border p-2"><VisitorActions items={n.rowActions} ctx={ctx} row={r} /></td> : null}</tr>)}</tbody>)}</table></div>;
  },
  thread: (n, ctx) => <section className="space-y-4">{rows(ctx, n.from).map((r) => <article key={r.key} className="border-b border-border pb-3"><p className="text-xs text-muted-foreground">{n.author ? renderText(`{$row.${n.author}}`, rowText(ctx, n.from, r)) : ""}{n.at ? ` · ${renderText(`{$row.${n.at}|time}`, rowText(ctx, n.from, r))}` : ""}</p><p className="whitespace-pre-wrap text-sm">{String(valueAt(r, n.body) ?? "")}</p></article>)}{!rows(ctx, n.from).length && <p className="text-sm text-muted-foreground">{n.empty ?? "No messages"}</p>}{n.post && <VisitorWriteAction action={{ op: n.post.op, fixed: n.post.fixed, label: n.post.button ?? "Reply", fields: [{ field: n.post.field, label: n.post.label ?? "Message" }] }} ctx={ctx} />}</section>,
  actions: (n, ctx) => <VisitorActions items={n.items ?? []} ctx={ctx} />,
  empty: (n, ctx) => <div className="border border-border p-6 text-center text-sm"><p>{renderText(n.text, ctx.text)}</p>{n.action && <VisitorActions items={[n.action]} ctx={ctx} />}</div>,
  tabs: (n, ctx) => <VisitorTabs n={n} ctx={ctx} />,
};

function VisitorNodes({ nodes, ctx }: { nodes: readonly Node[]; ctx: VisitorCtx }) {
  return <>{nodes.filter((n) => nodeShows(n.when, ctx.payload.data)).map((n, i) => <div key={i} className="mb-6">{Object.hasOwn(RENDERERS, n.c) ? RENDERERS[n.c as Allowed](n as never, ctx) : null}</div>)}</>;
}

export function VisitorPage({ payload, navigate, run, upload, download }: { payload: SharePayload; navigate: (path: string) => void; run?: VisitorRunner; upload?: VisitorUploader; download?: (id: string) => Promise<void> }) {
  const members = new Map(Object.entries(payload.members).map(([id, m]) => [id, m.name ?? m.title ?? ""]));
  const ctx: VisitorCtx = { payload, navigate: (path) => { if (sharePath(path, payload)) navigate(path); }, run, upload, download, text: { binds: payload.data, members, currency: "USD", files: payload.files, labels: payload.labels, formats: payload.formats } };
  return <main className="mx-auto max-w-4xl bg-background px-6 py-8 text-foreground"><VisitorNodes nodes={payload.page.body} ctx={ctx} /><footer className="mt-12 border-t border-border pt-4 text-xs text-muted-foreground">Shared by {payload.workspace} through Canon. Your visits are recorded for them. Names and emails are self-declared unless marked verified.</footer></main>;
}

export function ModuleSharePreview({ module, share, recordKey, path: initial }: { module: string; share: string; recordKey: string; path?: string }) {
  const [path, setPath] = useState(initial);
  const payload = useQuery(api.modules.previewShare, { module, share, key: recordKey, path });
  return <div className="min-h-screen bg-background"><p className="border-b border-border bg-muted px-6 py-3 text-center text-sm">Preview as customer. Actions are off. This preview does not record a visit.</p>{payload === undefined ? <p className="p-6 text-sm">Loading preview...</p> : payload ? <VisitorPage payload={payload} navigate={setPath} /> : <p className="p-6 text-sm">This shared page is unavailable.</p>}</div>;
}
