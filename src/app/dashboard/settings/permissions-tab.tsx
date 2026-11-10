"use client";

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { Eye } from "lucide-react";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { unhideableFields, type FieldLevel, type ObjectRule, type Visibility } from "../../../../convex/lib/access";
import { ROLE_BASES } from "../../../../convex/lib/roles";
import { useObjectLabels } from "@/components/records/object-labels";
import { LoadingRows } from "@/components/dashboard";
import { toast } from "@/lib/toast";
import { getErrorMessage } from "@/lib/utils";
import { SelectField } from "@/components/ui/select";

const ROLE_LABELS: Record<string, string> = { manager: "Managers", rep: "Reps", other: "Other members" };
const BASE_LABELS: Record<string, string> = { manager: "a manager", rep: "a rep", other: "another member" };
const VISIBILITY_LABELS: Record<Visibility, string> = { all: "All records", team: "Their teams' records", own: "Only their own" };
/** The objects with list and record pages, in nav order; custom objects follow. */
const STANDARD = ["account", "contact", "deal", "lead", "task", "note", "call", "meeting"] as const;
const OPS = ["read", "create", "edit", "delete"] as const;

type Row = Required<Omit<ObjectRule, "fields">> & { fields?: ObjectRule["fields"] };
const FULL = { visibility: "all" as Visibility, unowned: true, read: true, create: true, edit: true, delete: true };

/** A role's stored rules as one row per object, full access where nothing is stored. */
function rowsOf(objects: readonly string[], rules: readonly ObjectRule[]): Row[] {
  const byObject = new Map(rules.map((r) => [r.object, r]));
  return objects.map((object) => ({ object, ...FULL, ...byObject.get(object) }) as Row);
}

/** Only what narrows access is stored: an object with full access and no field rules has no rule. */
function rulesOf(rows: readonly Row[]): ObjectRule[] {
  return rows
    .filter((r) => r.visibility !== "all" || !r.unowned || OPS.some((op) => !r[op]) || r.fields?.length)
    .map(({ object, visibility, unowned, read, create, edit, delete: del, fields }) => ({
      object, visibility, unowned, read, create, edit, delete: del, ...(fields?.length ? { fields } : {}),
    }));
}

const cell = "px-2 py-1.5";

/** One object's fields for a role: editable (the default), read-only or hidden. */
function FieldRules({ object, label, fields, onChange }: { object: string; label: string; fields: ObjectRule["fields"]; onChange: (fields: NonNullable<ObjectRule["fields"]>) => void }) {
  const described = useQuery(api.objects.describe, { object });
  const levels = new Map((fields ?? []).map((f) => [f.apiName, f.level]));
  if (described === undefined) return <p className="text-xs text-muted-foreground">Loading fields…</p>;
  if (!described) return null;
  const list = described.fields.filter((f) => !f.system);
  // A title or a duplicate key shows wherever the record does: read-only at most.
  const unhideable = new Set(unhideableFields(object, described.fields.find((f) => f.fieldId === described.titleFieldId)?.apiName));
  const set = (apiName: string, level: FieldLevel | "editable") => {
    const next = new Map(levels);
    if (level === "editable") next.delete(apiName);
    else next.set(apiName, level);
    onChange([...next].map(([a, l]) => ({ apiName: a, level: l })));
  };
  return (
    <div className="grid grid-cols-2 gap-x-6 gap-y-1 py-2 sm:grid-cols-3">
      {list.map((f) => (
        <label key={f.apiName} className="flex items-center justify-between gap-2 text-sm">
          <span className="truncate">{f.label}</span>
          <SelectField aria-label={`${label}: ${f.label}`} value={levels.get(f.apiName) ?? "editable"} onValueChange={(v) => set(f.apiName, v as FieldLevel | "editable")}
            options={[
              { value: "editable", label: "Editable" },
              { value: "readOnly", label: "Read-only" },
              { value: "hidden", label: "Hidden", disabled: unhideable.has(f.apiName) },
            ]} />
        </label>
      ))}
    </div>
  );
}
const btn = "border border-border px-3 py-1 text-xs hover:bg-muted disabled:opacity-40";

type Grantable = { key: string; label: string; managers: boolean };
type RoleDraft = { key?: string; name: string; base: string; capabilities: string[] };

/** A workspace role's name, the built-in role it counts as, and what it may do beyond its record rules. */
function RoleEditor({ draft, grantable, onDone }: { draft: RoleDraft; grantable: readonly Grantable[]; onDone: (key: string | null) => void }) {
  const define = useMutation(api.permissions.defineWorkspaceRole);
  const remove = useMutation(api.permissions.removeWorkspaceRole);
  const [d, setD] = useState(draft);
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<string | null>, ok: string) => {
    setBusy(true);
    try {
      const key = await fn();
      toast.success(ok);
      onDone(key);
    } catch (cause) {
      void toast.error(getErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  };
  const toggle = (key: string) => setD({ ...d, capabilities: d.capabilities.includes(key) ? d.capabilities.filter((c) => c !== key) : [...d.capabilities, key] });
  return (
    <div className="space-y-3 border border-border bg-muted/20 p-3">
      <div className="flex flex-wrap items-end gap-3">
        <label className="grid gap-1 text-xs">Name<input aria-label="Role name" value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} className="border border-border bg-background px-2 py-1 text-sm" /></label>
        <label className="grid gap-1 text-xs">Counts as
          <SelectField aria-label="Counts as" value={d.base} onValueChange={(base) => setD({ ...d, base })} options={ROLE_BASES.map((b) => ({ value: b, label: BASE_LABELS[b] }))} />
        </label>
        <button type="button" className={btn} onClick={() => setD({ ...d, capabilities: grantable.filter((g) => g.managers).map((g) => g.key) })}>Same as managers</button>
      </div>
      <p className="text-xs text-muted-foreground">Counts as decides who can manage reps and own agents. Billing, roles, the data model, webhooks, automations, grants and the write gate stay with admins.</p>
      <fieldset className="grid gap-1 sm:grid-cols-2">
        <legend className="mb-1 text-xs font-medium">May also</legend>
        {grantable.map((g) => (
          <label key={g.key} className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-1" checked={d.capabilities.includes(g.key)} onChange={() => toggle(g.key)} />{g.label}
          </label>
        ))}
      </fieldset>
      <div className="flex gap-2">
        <button type="button" disabled={busy || !d.name.trim()} className={`${btn} border-primary`} onClick={() => void run(() => define({ ...(d.key ? { key: d.key } : {}), name: d.name, base: d.base, capabilities: d.capabilities }), `Saved ${d.name.trim()}`)}>Save role</button>
        <button type="button" className={btn} onClick={() => onDone(d.key ?? null)}>Cancel</button>
        {d.key && <button type="button" disabled={busy} className={btn} onClick={() => { if (window.confirm(`Delete ${d.name}?`)) void run(async () => { await remove({ key: d.key! }); return null; }, `Deleted ${d.name}`); }}>Delete role</button>}
      </div>
    </div>
  );
}

/**
 * Settings, Permissions (CP14): for each role, which records of each object
 * its members see, and what they may do with them. Admins always have full
 * access. "View as" previews one member's access, read-only.
 */
export function PermissionsTab() {
  const settings = useQuery(api.permissions.settings);
  const customObjects = useQuery(api.customObjects.list);
  const saveRole = useMutation(api.permissions.saveRole);
  const startPreview = useMutation(api.permissions.startPreview);
  const [role, setRole] = useState("rep");
  const [editing, setEditing] = useState<RoleDraft | null>(null);
  const names = useObjectLabels();
  const [draft, setDraft] = useState<Row[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [previewId, setPreviewId] = useState("");
  const [openFields, setOpenFields] = useState<string | null>(null);

  const objects = useMemo(() => [
    ...STANDARD.map((o) => ({ object: o as string, label: names(o)?.pluralLabel ?? o })),
    ...(customObjects ?? []).filter((o) => !o.archived).map((o) => ({ object: o.apiName, label: o.pluralLabel })),
  ], [customObjects, names]);
  const stored = settings?.roles.find((r) => r.role === role);
  const nameOf = (r: { role: string; custom?: { name: string } }) => r.custom?.name ?? ROLE_LABELS[r.role] ?? r.role;
  useEffect(() => setDraft(null), [role]);

  if (settings === undefined) return <LoadingRows count={4} height="h-10" />;
  if (settings === null) return <p className="text-sm text-muted-foreground">Only admins change permissions.</p>;

  const owned = new Set([...settings.ownedObjects, ...(customObjects ?? []).map((o) => o.apiName)]);
  const rows = draft ?? rowsOf(objects.map((o) => o.object), stored?.rules ?? []);
  const set = (object: string, patch: Partial<Row>) => setDraft(rows.map((r) => (r.object === object ? { ...r, ...patch } : r)));
  const previewable = settings.members.filter((m) => m.role !== "admin");

  async function save() {
    setBusy(true);
    try {
      // Rules for objects this screen does not list (an archived custom object's) are kept as they were.
      const listed = new Set(rows.map((r) => r.object));
      const kept = (stored?.rules ?? []).filter((r) => !listed.has(r.object));
      await saveRole({ role, rules: [...kept, ...rulesOf(rows)] });
      setDraft(null);
      toast.success(`${stored ? nameOf(stored) : role} saved`);
    } catch (cause) {
      void toast.error(getErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function preview() {
    if (!previewId) return;
    try {
      await startPreview({ asUserId: previewId as Id<"users"> });
      toast.success("Viewing as that member. Changes are off until you exit.");
    } catch (cause) {
      void toast.error(getErrorMessage(cause));
    }
  }

  return (
    <div className="space-y-6">
      <section className="space-y-3 border border-border bg-card p-4">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-sm font-semibold">Who sees and changes what</h2>
          <div className="flex gap-1" role="tablist" aria-label="Role">
            {settings.roles.map((r) => (
              <button key={r.role} role="tab" aria-selected={role === r.role} onClick={() => { setRole(r.role); setEditing(null); }}
                className={`${btn} ${role === r.role ? "border-primary bg-muted font-medium" : ""}`}>{nameOf(r)}</button>
            ))}
          </div>
          <button type="button" className={btn} onClick={() => setEditing({ name: "", base: "rep", capabilities: [] })}>New role</button>
          {stored?.custom && !editing && <button type="button" className={btn} onClick={() => setEditing({ key: role, name: stored.custom!.name, base: stored.custom!.base, capabilities: [...stored.custom!.capabilities] })}>Edit role</button>}
        </div>
        {editing && <RoleEditor key={editing.key ?? "new"} draft={editing} grantable={settings.grantable} onDone={(key) => { setEditing(null); if (key) setRole(key); else if (key === null && editing.key) setRole("rep"); }} />}
        {stored?.custom && !editing && (
          <p className="text-xs text-muted-foreground">
            Counts as {BASE_LABELS[stored.custom.base]}. May also: {stored.custom.capabilities.length ? settings.grantable.filter((g) => stored.custom!.capabilities.includes(g.key)).map((g) => g.label.toLowerCase()).join("; ") : "nothing beyond its record rules"}.
          </p>
        )}
        <p className="text-xs text-muted-foreground">
          Admins always see and change everything. Records are someone&apos;s by their owner field; a team is its members and its lead. A hidden field leaves pages, search, reports, exports and the API; a read-only one shows but cannot be changed.
          API tokens and agents act with the role of the person they belong to.
        </p>
        <table className="w-full text-sm">
          <thead className="text-left text-xs font-medium text-muted-foreground">
            <tr>
              <th className={cell}>Object</th><th className={cell}>Sees</th><th className={cell}>Unowned too</th>
              {OPS.map((op) => <th key={op} className={cell}>{op}</th>)}
              <th className={cell}>Fields</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const label = objects.find((o) => o.object === r.object)?.label ?? r.object;
              const hasOwner = owned.has(r.object);
              const fieldCount = r.fields?.length ?? 0;
              return [
                <tr key={r.object} className="border-t border-border">
                  <td className={`${cell} font-medium`}>{label}</td>
                  <td className={cell}>
                    <SelectField aria-label={`${label}: records seen`} value={hasOwner ? r.visibility : "all"} disabled={!hasOwner || !r.read}
                      onValueChange={(v) => set(r.object, { visibility: v as Visibility })}
                      options={(Object.keys(VISIBILITY_LABELS) as Visibility[]).map((v) => ({ value: v, label: VISIBILITY_LABELS[v] }))} />
                  </td>
                  <td className={cell}>
                    <input type="checkbox" aria-label={`${label}: unowned records too`} checked={r.unowned} disabled={!hasOwner || r.visibility === "all" || !r.read}
                      onChange={(e) => set(r.object, { unowned: e.target.checked })} />
                  </td>
                  {OPS.map((op) => (
                    <td key={op} className={cell}>
                      <input type="checkbox" aria-label={`${label}: ${op}`} checked={r[op]} disabled={op !== "read" && !r.read}
                        onChange={(e) => set(r.object, op === "read" && !e.target.checked ? { read: false, create: false, edit: false, delete: false } : { [op]: e.target.checked })} />
                    </td>
                  ))}
                  <td className={cell}>
                    <button className={btn} aria-expanded={openFields === r.object} onClick={() => setOpenFields(openFields === r.object ? null : r.object)}>
                      {fieldCount ? `${fieldCount} limited` : "All editable"}
                    </button>
                  </td>
                </tr>,
                openFields === r.object && (
                  <tr key={`${r.object}:fields`}>
                    <td colSpan={8} className="bg-muted/30 px-4">
                      <FieldRules object={r.object} label={label} fields={r.fields} onChange={(fields) => set(r.object, { fields })} />
                    </td>
                  </tr>
                ),
              ];
            })}
          </tbody>
        </table>
        <div className="flex items-center gap-2">
          <button onClick={() => void save()} disabled={busy || !draft} className={`${btn} border-primary`}>Save {stored ? nameOf(stored) : role}</button>
          {draft && <button onClick={() => setDraft(null)} className={btn}>Discard</button>}
          {stored?.updatedAt && !draft && <span className="text-xs text-muted-foreground">Saved {new Date(stored.updatedAt).toLocaleString()}</span>}
        </div>
      </section>

      <section className="space-y-2 border border-border bg-card p-4">
        <h2 className="flex items-center gap-2 text-sm font-semibold"><Eye className="h-4 w-4" />View as a member</h2>
        <p className="text-xs text-muted-foreground">See the workspace as one member sees it: their lists, search, record pages and reports. Nothing can be changed while you preview; it ends after 30 minutes.</p>
        <div className="flex items-center gap-2">
          <SelectField aria-label="Member to view as" value={previewId} onValueChange={setPreviewId}
            options={[{ value: "", label: "Pick a member" }, ...previewable.map((m) => ({ value: m.id, label: `${m.name} (${m.role})` }))]} />
          <button onClick={() => void preview()} disabled={!previewId} className={btn}>View as</button>
        </div>
      </section>
    </div>
  );
}
