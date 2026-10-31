import type { ModuleManifest, ShareDecl, ShareWhere } from "../../../modules/kernel/manifest.ts";
import { canonicalJson } from "../../../modules/kernel/integrity.ts";
import { coreOf, filesIn, refsIn, type FieldSpec } from "../../../modules/kernel/schema.ts";
import type { ModuleDoc, FileInfo } from "./scope.ts";

export type ShareDoc = { key: string; version: number; data: Record<string, unknown> };
export type VisitorForm = { label: string; kind?: "create" | "update"; fields: Record<string, FieldSpec>; confirm?: string; choices?: Record<string, Array<{ key: string; label: string }>> };
export type ShareDocs = Record<string, ShareDoc[]>;
export type SharePayload = {
  workspace: string;
  title: string;
  page: ShareDecl["pages"][number];
  pages: Array<{ path: string; title: string }>;
  data: Record<string, ShareDoc | ShareDoc[] | null>;
  members: Record<string, Partial<Record<"name" | "title", string | null>>>;
  files: Record<string, FileInfo>;
  labels: Record<string, Record<string, Record<string, string>>>;
  formats: Record<string, Record<string, string>>;
  machines: Record<string, { field: string; states: readonly string[] }>;
  writes: { ops: Record<string, VisitorForm>; transitions: Record<string, VisitorForm> };
};

export function shareWhereHolds(where: ShareWhere | undefined, data: Record<string, unknown>): boolean {
  if (!where) return true;
  if ("all" in where) return where.all.every((w) => shareWhereHolds(w, data));
  const value = data[where.field];
  return "in" in where ? where.in.includes((value ?? null) as never) : value !== undefined && value !== null && value !== where.neq;
}

export function inShareTree(manifest: ModuleManifest, share: ShareDecl, collection: string, doc: Pick<ModuleDoc, "key" | "parentKey">, rootKey: string): boolean {
  return Object.hasOwn(share.read, collection) && (collection === share.collection ? doc.key === rootKey : manifest.collections[collection]?.setOf?.parent === share.collection && doc.parentKey === rootKey);
}

export function projectShare(manifest: ModuleManifest, share: ShareDecl, rootKey: string, docs: Record<string, ModuleDoc[]>): ShareDocs {
  const root = docs[share.collection]?.find((d) => d.key === rootKey);
  const admitted: ShareDocs = Object.fromEntries(Object.entries(share.read).map(([c, read]) => [c, root && shareWhereHolds(share.when, root.data) && shareWhereHolds(share.read[share.collection]?.where, root.data) ? (docs[c] ?? [])
    .filter((d) => inShareTree(manifest, share, c, d, rootKey) && (c === share.collection || (d.gen ?? 0) === (root.gens?.[c] ?? root.gen ?? 0)) && shareWhereHolds(read.where, d.data))
    .map((d): ShareDoc => ({ key: d.key, version: d.version, data: Object.fromEntries(read.fields.filter((f) => Object.hasOwn(d.data, f)).map((f) => [f, d.data[f]])) })) : []]));
  for (const [c, rows] of Object.entries(admitted)) for (const row of rows) for (const [f, value] of Object.entries(row.data)) {
    const type = coreOf(manifest.collections[c].schema.value[f].fieldType);
    if (type.type === "ref" && type.to === "doc" && (!type.collection || !admitted[type.collection]?.some((d) => d.key === value))) delete row.data[f];
  }
  return admitted;
}

export function shareInputRefs(manifest: ModuleManifest, share: ShareDecl, docs: ShareDocs, specs: Record<string, FieldSpec>, values: Record<string, unknown>): boolean {
  return Object.entries(values).every(([field, value]) => {
    const spec = specs[field];
    if (!spec) return false;
    const refs = refsIn(value, spec.fieldType), type = coreOf(spec.fieldType);
    if (!refs.length) return true;
    return type.type === "ref" && type.to === "doc" && !!type.collection && (type.collection === share.collection || manifest.collections[type.collection]?.setOf?.parent === share.collection) && refs.every(({ ref, id }) => ref.to === "doc" && ref.collection === type.collection && !!share.read[type.collection!] && !!docs[type.collection!]?.some((d) => d.key === id));
  });
}

function sharedLabel(manifest: ModuleManifest, share: ShareDecl, collection: string, row: ShareDoc): string {
  const title = manifest.collections[collection]?.title;
  const spec = title && manifest.collections[collection]?.schema.value[title], t = spec && coreOf(spec.fieldType);
  const value = title && share.read[collection]?.fields.includes(title) && t && ["string", "number"].includes(t.type) ? row.data[title] : undefined;
  return typeof value === "string" || typeof value === "number" ? String(value) : "Shared item";
}

export function policyHashInput(manifest: ModuleManifest, share: ShareDecl): unknown {
  return {
    share,
    schemas: Object.fromEntries([...Object.keys(share.read), ...(share.record ? [share.record.collection] : [])].map((c) => [c, manifest.collections[c].schema])),
    trees: Object.fromEntries([...Object.keys(share.read), ...(share.record ? [share.record.collection] : [])].map((c) => {
      const { key, setOf, integrity } = manifest.collections[c];
      return [c, { key, ...(setOf ? { setOf } : {}), ...(integrity ? { integrity } : {}) }];
    })),
    ops: Object.fromEntries(share.write.ops.map((n) => [n, manifest.ops[n]])),
    transitions: Object.fromEntries(share.write.transitions.map((n) => {
      const [machine, name] = n.split(".");
      const { collection, field, states, initial, transitions } = manifest.machines![machine];
      return [n, { collection, field, states, initial, transition: transitions[name] }];
    })),
  };
}

export async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export const sharePolicyHash = (manifest: ModuleManifest, share: ShareDecl): Promise<string> => sha256(canonicalJson(policyHashInput(manifest, share)));

export function shareReferences(manifest: ModuleManifest, share: ShareDecl, docs: ShareDocs) {
  const members = new Set<string>(), team = new Set<string>(), files = new Set<string>();
  for (const [c, rows] of Object.entries(docs)) for (const doc of rows) {
    for (const r of refsIn(doc.data, manifest.collections[c].schema)) if (r.ref.to === "users") {
      members.add(r.id);
      if (c === share.collection) team.add(r.id);
    }
    for (const f of filesIn(doc.data, manifest.collections[c].schema)) files.add(f.id);
  }
  return { members: [...members].filter((id) => team.has(id)), files: [...files] };
}

export function sharePayload(manifest: ModuleManifest, share: ShareDecl, docs: ShareDocs, workspace: string, members: SharePayload["members"], files: SharePayload["files"], path?: string): SharePayload | null {
  const page = path ? share.pages.find((p) => {
    const pattern = p.path.split("/"), parts = path.split("?")[0].split("/");
    return pattern.length === parts.length && pattern.every((s, i) => s.startsWith(":") || s === parts[i]);
  }) : share.pages[0];
  if (!page || !docs[share.collection]?.length) return null;
  const params = Object.fromEntries(page.path.split("/").flatMap((part, i) => part.startsWith(":") ? [[part.slice(1), path?.split("?")[0].split("/")[i]]] : []));
  const data: SharePayload["data"] = {};
  for (const [name, b] of Object.entries(page.bind ?? {})) {
    if ("root" in b) data[name] = docs[share.collection][0];
    else if ("rootList" in b) {
      const value = docs[share.collection][0].data[b.rootList];
      if (Array.isArray(value) && value.length > 100) return null;
      data[name] = Array.isArray(value) ? value.flatMap((item, i) => item && typeof item === "object" && !Array.isArray(item) ? [{ key: String(i), version: 0, data: item as Record<string, unknown> }] : []) : [];
    } else {
      let rows = docs[b.set] ?? [];
      if (b.where) rows = rows.filter((d) => d.data[b.where!.field] === params[b.where!.eq.route]);
      if (b.key) {
        const selected = rows.find((d) => d.key === params[b.key!.route]);
        if (!selected) return null;
        data[name] = selected;
      } else data[name] = rows;
    }
  }
  const machines = Object.fromEntries(Object.entries(manifest.machines ?? {})
    .filter(([, m]) => share.read[m.collection]?.fields.includes(m.field))
    .map(([name, m]) => [name, { field: m.field, states: m.states }]));
  const labels: SharePayload["labels"] = {}, formats: SharePayload["formats"] = {};
  for (const [name, b] of Object.entries(page.bind ?? {})) {
    const c = "root" in b || "rootList" in b ? share.collection : b.set;
    const listSpec = "rootList" in b ? manifest.collections[c].schema.value[b.rootList] : undefined;
    const listType = listSpec && coreOf(listSpec.fieldType);
    const specs = listType?.type === "array" && listType.value.type === "object" ? listType.value.value : manifest.collections[c].schema.value;
    const projected = "rootList" in b ? Object.keys(specs) : share.read[c].fields;
    labels[name] = {}; formats[name] = {};
    for (const f of projected) {
      const sp = specs[f], type = coreOf(sp.fieldType);
      if (type.type === "union" && type.labels) labels[name][f] = { ...type.labels };
      if (type.type === "ref" && type.to === "users") formats[name][f] = "user";
      if (type.type === "ref" && type.to === "doc" && type.collection) {
        const collection = type.collection;
        labels[name][f] = Object.fromEntries((docs[collection] ?? []).map((d) => [d.key, sharedLabel(manifest, share, collection, d)]));
      }
      if (type.type === "file") formats[name][f] = "file";
      if (sp.widget === "date" || sp.widget === "time") formats[name][f] = sp.widget;
    }
  }
  const referenced = shareReferences(manifest, share, docs);
  const shownMembers = Object.fromEntries(referenced.members.filter((id) => Object.hasOwn(members, id)).map((id) => [id, Object.fromEntries(share.members.map((f) => [f, members[id][f] ?? null]))]));
  const shownFiles = Object.fromEntries(referenced.files.filter((id) => Object.hasOwn(files, id)).map((id) => [id, { name: files[id].name, type: files[id].type, bytes: files[id].bytes, ...(files[id].buyer ? { buyer: files[id].buyer } : {}) }]));
  const fields = (specs: Record<string, FieldSpec>) => Object.fromEntries(Object.entries(specs).map(([f, sp]) => [f, { fieldType: sp.fieldType, optional: sp.optional, ...(sp.label ? { label: sp.label } : {}), ...(sp.widget ? { widget: sp.widget } : {}) }]));
  const choices = (specs: Record<string, FieldSpec>) => Object.fromEntries(Object.entries(specs).flatMap(([f, sp]) => {
    const t = coreOf(sp.fieldType);
    if (t.type !== "ref" || t.to !== "doc" || !t.collection) return [];
    const collection = t.collection;
    return [[f, (docs[collection] ?? []).map((d) => ({ key: d.key, label: sharedLabel(manifest, share, collection, d) }))]];
  }));
  const writes: SharePayload["writes"] = {
    ops: Object.fromEntries(share.write.ops.flatMap((name) => {
      const op = manifest.ops[name];
      if (!op || op.kind === "delete" || op.share === undefined || !op.roles.includes("visitor")) return [];
      return [[name, { label: op.label, kind: op.kind, choices: choices(Object.fromEntries((op.fields ?? []).filter((f) => !Object.hasOwn(op.set ?? {}, f)).map((f) => [f, manifest.collections[op.collection].schema.value[f]]))), fields: fields(Object.fromEntries((op.fields ?? []).filter((f) => !Object.hasOwn(op.set ?? {}, f)).map((f) => [f, manifest.collections[op.collection].schema.value[f]]))) }]];
    })),
    transitions: Object.fromEntries(share.write.transitions.flatMap((name) => {
      const [machine, transition] = name.split("."), t = manifest.machines?.[machine]?.transitions[transition];
      return t?.roles.includes("visitor") && t.share !== undefined ? [[name, { label: t.label, choices: choices(t.args?.value ?? {}), fields: fields(t.args?.value ?? {}), ...(t.confirm ? { confirm: t.confirm } : {}) }]] : [];
    })),
  };
  return { workspace, labels, formats, title: share.label, page, pages: share.pages.map(({ path, title }) => ({ path, title })), data, members: shownMembers, files: shownFiles, machines, writes };
}
