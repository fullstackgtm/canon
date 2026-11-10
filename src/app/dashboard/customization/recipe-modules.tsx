"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import { useAction, useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { ArrowUpCircle, ChevronRight, Trash2 } from "lucide-react";
import { api } from "../../../../convex/_generated/api";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { toast } from "@/lib/toast";
import { cn, getErrorMessage } from "@/lib/utils";

type Preview = FunctionReturnType<typeof api.modules.previewInstall>;
type Installed = NonNullable<FunctionReturnType<typeof api.modules.installed>>["modules"][number];
type Example = NonNullable<FunctionReturnType<typeof api.modules.examples>>["examples"][number];

const btn = "inline-flex items-center gap-1 border border-border px-2 py-1 text-xs font-medium hover:bg-muted disabled:opacity-50";
const primary = cn(btn, "border-primary bg-primary text-primary-foreground hover:bg-primary/90");
const heading = "text-xs font-medium text-muted-foreground";
const tag = "inline-flex items-center border border-border px-1.5 py-0.5 text-xs font-medium text-muted-foreground";
type NavEntry = { section: string; label: string; href: string };
const navEntries = (m: { nav: NavEntry | null; links: readonly NavEntry[] }): NavEntry[] => [...m.links, ...(m.nav ? [m.nav] : [])];

/** Where a module came from, and the newer build Canon ships when it has one. */
export function moduleStatus(m: Pick<Installed, "moduleId" | "source">, examples: readonly Example[]) {
  const ex = examples.find((x) => x.moduleId === m.moduleId);
  const fromCanon = m.source.startsWith("canon:");
  return { fromCanon, update: fromCanon && ex?.installed && !ex.installed.current ? { version: ex.version, source: ex.source } : null };
}
/** What `reads.records` grants: the Canon objects a module reports on, each as the reading person's role shows it. */
const recordGrants = (names: readonly string[]) =>
  `${names.includes("*") ? "every record type, custom objects too" : names.join(", ")}, with every field and related record each person's role shows them`;

/**
 * The workspace's modules (docs/modules.md), one row each: on or off, version, source and a newer build, with one
 * action. Its details hold its commit, background work, an upgrade in progress, and turning it off or uninstalling.
 */
export function InstalledModules({ onInstall, onBrowse }: { onInstall: (source: string) => void; onBrowse: () => void }) {
  const view = useQuery(api.modules.installed);
  const catalog = useQuery(api.modules.examples);
  const setEnabled = useMutation(api.modules.setEnabled);
  const uninstall = useMutation(api.modules.uninstall);
  const cancelUpgrade = useMutation(api.modules.cancelUpgrade);
  const grants = useQuery(api.moduleGrants.list);
  const [busy, setBusy] = useState(false);
  if (!view) return <div className="h-14 animate-pulse border border-border bg-muted/40" />;

  async function run(change: () => Promise<unknown>, done: string) {
    setBusy(true);
    try { await change(); toast.success(done); } catch (e) { toast.error(getErrorMessage(e)); } finally { setBusy(false); }
  }
  const toggle = (m: Installed) => void run(() => setEnabled({ moduleId: m.moduleId, enabled: !m.enabled }), m.enabled ? `${m.title} turned off` : `${m.title} turned on`);

  if (!view.modules.length) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-3 border border-dashed border-border px-4 py-4 text-sm text-muted-foreground">
        No modules installed.
        <button type="button" className={btn} onClick={onBrowse}>Browse modules</button>
      </div>
    );
  }
  return (
    <ul className="divide-y divide-border border border-border bg-card">
      {view.modules.map((m) => (
        <ModuleRow key={m.moduleId} m={m} status={moduleStatus(m, catalog?.examples ?? [])} canEdit={view.canEdit} busy={busy} onInstall={onInstall} onToggle={() => toggle(m)}
          grants={grants?.modules.filter((g) => g.moduleId === m.moduleId).map((g) => <GrantsLine key={g.moduleId} moduleId={g.moduleId} operations={g.operations} canManage={grants.canManage} signingReady={grants.signingReady} maxDays={grants.maxDays} />)}
          onCancelUpgrade={() => void run(() => cancelUpgrade({ moduleId: m.moduleId }), "Upgrade cancelled")}
          onUninstall={() => void run(() => uninstall({ moduleId: m.moduleId }), `${m.title} uninstalled`)} />
      ))}
    </ul>
  );
}

function ModuleRow({ m, status: { fromCanon, update }, canEdit, busy, grants, onInstall, onToggle, onCancelUpgrade, onUninstall }: {
  m: Installed; status: ReturnType<typeof moduleStatus>; canEdit: boolean; busy: boolean; grants: ReactNode;
  onInstall: (source: string) => void; onToggle: () => void; onCancelUpgrade: () => void; onUninstall: () => void;
}) {
  const [open, setOpen] = useState(false);
  const imports = m.imports ?? [];
  const attention = imports.some((i) => i.error) || m.upgrade?.error || m.jobs?.feedError || m.jobs?.runnerPaused || m.jobs?.feeds?.some((f) => f.error) || (m.jobs?.failed.length ?? 0) > 0;
  return (
    <li>
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-4 py-3">
        <button type="button" aria-expanded={open} className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-left" onClick={() => setOpen(!open)}>
          <ChevronRight className={cn("h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />
          <span className="text-sm font-medium">{m.title}</span>
          <span className={cn(tag, m.enabled && "border-primary text-primary")}>{m.enabled ? "On" : "Off"}</span>
          <span className={tag}>v{m.version}</span>
          <span className={cn(tag, m.development && "border-warning text-warning")}>{m.development ? "Development install" : fromCanon ? "Canon" : "GitHub"}</span>
          <span className="text-xs text-muted-foreground">{navEntries(m)[0]?.section} · {m.pages} {m.pages === 1 ? "page" : "pages"}</span>
          {update && <span className={cn(tag, "border-warning text-warning")}>v{update.version} available</span>}
          {m.upgrade && !m.upgrade.error && <span className={cn(tag, "border-warning text-warning")}>Upgrading</span>}
          {attention && <span className={cn(tag, "border-destructive text-destructive")}>Needs attention</span>}
        </button>
        <span className="flex shrink-0 items-center gap-2">
          {update && canEdit && !m.upgrade
            ? <button type="button" className={primary} disabled={busy} onClick={() => onInstall(update.source)}>Update</button>
            : m.enabled
              ? <Link className={primary} href={navEntries(m)[0]?.href ?? "/dashboard"}>Open</Link>
              : canEdit && <button type="button" className={primary} disabled={busy} onClick={onToggle}>Turn on</button>}
        </span>
      </div>
      {m.autoUpgrade && m.autoUpgrade.newReads.length > 0 && (
        <p className="px-4 pb-2 text-xs text-muted-foreground" role="status">
          Upgraded to v{m.autoUpgrade.version}; now also reads: {m.autoUpgrade.newReads.join(", ")}
        </p>
      )}
      {imports.map((i) => (
        <p key={i.name} className={cn("px-4 pb-2 text-xs", i.error ? "text-destructive" : "text-muted-foreground")} role="status">
          {i.label}: {i.error ? `Stopped. ${i.error}` : i.done ? "Imported" : "Importing"}
        </p>
      ))}
      {open && (
        <div className="space-y-2 border-t border-border px-4 py-3 sm:pl-9">
          <p className="max-w-[72ch] text-sm text-muted-foreground">{m.description}</p>
          <p className="break-all font-mono text-[11px] text-muted-foreground">{m.moduleId} · by {m.author} · {m.source} · {m.sha.slice(0, 12)}</p>
          {m.jobs && <JobsLine jobs={m.jobs} />}
          {grants}
          {m.upgrade && (
            <p className={cn("text-xs", m.upgrade.error ? "text-destructive" : "text-muted-foreground")} role="status">
              {upgradeLine(m.version, m.upgrade)}
              {canEdit && m.upgrade.phase !== "cutover" && <button type="button" className="ml-2 underline" disabled={busy} onClick={onCancelUpgrade}>Cancel upgrade</button>}
            </p>
          )}
          {canEdit && (
            <div className="flex flex-wrap gap-2 pt-1">
              <button type="button" role="switch" aria-checked={m.enabled} aria-label={`${m.title} on`} className={btn} disabled={busy} onClick={onToggle}>{m.enabled ? "Turn off" : "Turn on"}</button>
              {(!m.upgrade || m.upgrade.error) && !m.development && (
                <button type="button" className={btn} disabled={busy} onClick={() => onInstall(update?.source ?? m.source)}><ArrowUpCircle className="h-3.5 w-3.5" />{m.upgrade ? "Upgrade to a fixed version" : "Check for updates"}</button>
              )}
              <button type="button" className={btn} disabled={busy || m.enabled} title={m.enabled ? "Turn it off first" : undefined} onClick={onUninstall}><Trash2 className="h-3.5 w-3.5" />Uninstall</button>
            </div>
          )}
        </div>
      )}
    </li>
  );
}

/**
 * The modules Canon ships (docs/modules.md, "Modules Canon ships"), to browse: installed in one click with no
 * GitHub, and upgraded on the install screen once Canon ships a newer build.
 */
export function CanonModules({ onUpgrade }: { onUpgrade: (source: string) => void }) {
  const view = useQuery(api.modules.examples);
  const previewInstall = useAction(api.modules.previewInstall);
  const install = useAction(api.modules.install);
  const [busy, setBusy] = useState<string | null>(null);
  if (!view) return <div className="h-40 animate-pulse border border-border bg-muted/40" />;

  async function installNow(source: string) {
    setBusy(source);
    try {
      const p = await previewInstall({ source });
      // Data kept from an uninstall is upgraded in place: its new reads and drops are approved on the install screen.
      if (p.upgrade) { onUpgrade(source); return; }
      await install({ source: p.source, sha: p.pinned.sha, manifestHash: p.manifestHash });
      toast.success(`${p.title} installed. Turn it on to add it to the nav.`);
    } catch (e) { toast.error(getErrorMessage(e)); } finally { setBusy(null); }
  }

  return (
    <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
      {view.examples.map((x) => (
        <li key={x.slug} className="flex flex-col gap-2 border border-border bg-card p-4">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-sm font-semibold">{x.title}</span>
            <span className="text-xs tabular-nums text-muted-foreground">v{x.version}</span>
          </div>
          <p className="line-clamp-3 text-xs leading-5 text-muted-foreground" title={x.description}>{x.description}</p>
          <div className="mt-auto flex items-center justify-between gap-2 pt-2">
            <span className="text-xs text-muted-foreground">{navEntries(x).map((n) => `${n.section} · ${n.label}`).join(", ")}{x.default ? " · on in every workspace" : ""}</span>
            {!x.installed && view.canEdit && (
              <button type="button" className={primary} disabled={busy !== null} onClick={() => void installNow(x.source)}>{busy === x.source ? "Installing…" : "Install"}</button>
            )}
            {x.installed && !x.installed.fromCanon && <span className={tag} title="Uninstall the GitHub copy (its data stays), then install Canon's build here.">Installed from GitHub</span>}
            {x.installed?.fromCanon && x.installed.current && <span className={cn(tag, "border-primary text-primary")}>Installed</span>}
            {x.installed?.fromCanon && !x.installed.current && view.canEdit && (
              <button type="button" className={primary} onClick={() => onUpgrade(x.source)}><ArrowUpCircle className="h-3.5 w-3.5" />Update to v{x.version}</button>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}

type Upgrade = NonNullable<NonNullable<FunctionReturnType<typeof api.modules.installed>>["modules"][number]["upgrade"]>;

/** How far a module's upgrade is, or the doc that stopped it (docs/modules.md, "Upgrades and migrations"). */
function upgradeLine(serving: string, u: Upgrade): string {
  if (u.error) return `Upgrade to v${u.version} stopped: ${u.error} v${serving} serves as before.`;
  const step = `step ${Math.min(u.step + 1, u.steps)} of ${u.steps}${u.collection ? `, ${u.collection}` : ""}`;
  if (u.phase === "cutover") return `Upgrading to v${u.version}: putting its migrated data in place (${step}). The module opens again in a moment.`;
  if (u.phase === "migrate") return `Upgrading to v${u.version}: migrating its data (${u.done} docs, ${step}). v${serving} serves, read only, until it is done.`;
  return `Upgrading to v${u.version}: rebuilding its data (${u.done} docs, ${step}). v${serving} serves until it is done.`;
}

type Jobs = NonNullable<NonNullable<FunctionReturnType<typeof api.modules.installed>>["modules"][number]["jobs"]>;

/** A module's background work (docs/modules.md, "Jobs, watches and schedules"): keys waiting, running, failing, and its deal feed. */
function JobsLine({ jobs: j }: { jobs: Jobs }) {
  const parts = [
    j.waiting || j.running ? `${j.waiting} waiting, ${j.running} running` : "nothing waiting",
    ...(j.retrying ? [`${j.retrying} retrying`] : []),
    j.lastRunAt ? `last run ${new Date(j.lastRunAt).toLocaleString()}` : "not run yet",
    ...(j.feedBehind === null ? [] : [j.feedBehind === 0 ? "deal feed current" : `deal feed ${j.feedBehind} ${j.feedBehind === 1 ? "entry" : "entries"} behind`]),
  ];
  return (
    <div className="space-y-0.5 text-xs" role="status">
      <p className="text-muted-foreground">Background work: {parts.join(" · ")}</p>
      {(j.feeds ?? []).map((f) => <p key={f.name} className={f.error ? "text-destructive" : "text-muted-foreground"}>{f.name} · {f.behind} behind{f.backfill ? " · backfill pending" : ""}{f.error ? ` · ${f.error}` : ""}</p>)}
      {j.feedError && <p className="text-destructive">The deal feed stopped: {j.feedError}</p>}
      {j.runnerPaused && <p className="text-destructive">{j.runnerPaused}</p>}
      {j.failed.map((f) => <p key={`${f.job}:${f.key}`} className="text-destructive">{f.job} {f.key} stopped after {f.attempts} tries: {f.error}</p>)}
    </div>
  );
}

type Grants = NonNullable<FunctionReturnType<typeof api.moduleGrants.list>>["modules"][number]["operations"];

/**
 * A module's standing grants (docs/modules.md, "Standing grants"): what an admin lets it do without asking, until when,
 * and how much of it ran today. An admin allows it for the longest a grant lasts, or revokes it.
 */
function GrantsLine({ moduleId, operations, canManage, signingReady, maxDays }: { moduleId: string; operations: Grants; canManage: boolean; signingReady: boolean; maxDays: number }) {
  const create = useMutation(api.moduleGrants.create);
  const revoke = useMutation(api.moduleGrants.revoke);
  const [busy, setBusy] = useState(false);
  async function run(change: () => Promise<unknown>, done: string) {
    setBusy(true);
    try { await change(); toast.success(done); } catch (e) { toast.error(getErrorMessage(e)); } finally { setBusy(false); }
  }
  return (
    <div className="space-y-0.5 text-xs">
      {operations.map((o) => {
        const live = o.grants.find((g) => g.state === "live");
        const last = live ?? o.grants[0];
        return (
          <p key={o.operation} className="text-muted-foreground">
            <span className="font-medium text-foreground">{o.grantable}</span>
            {live ? <>: without asking, allowed by {live.createdBy ?? "an admin"} until {new Date(live.expiresAt).toLocaleDateString()} ({live.usedToday} today{live.maxPerDay ? ` of ${live.maxPerDay}` : ""})</>
              : <>: each time on Patch plans{last ? ` (last grant ${last.stateLabel.toLowerCase()})` : ""}</>}
            {canManage && !signingReady && <span className="ml-2">Grants can&apos;t be signed on this deployment yet: its encryption key isn&apos;t configured.</span>}
            {canManage && signingReady && (live
              ? <button type="button" className="ml-2 underline" disabled={busy} onClick={() => void run(() => revoke({ grantId: live.id }), "Grant revoked")}>Revoke</button>
              : <button type="button" className="ml-2 underline" disabled={busy} onClick={() => void run(() => create({ moduleId, operation: o.operation, days: maxDays }), `Allowed for ${maxDays} days`)}>Allow without asking for {maxDays} days</button>)}
          </p>
        );
      })}
    </div>
  );
}

/**
 * Preview a module at the commit its source names now, then install it pinned to that commit. Over an installed
 * version it upgrades in place: what it newly reads needs approving here, and a collection it removes with its docs
 * needs ticking.
 */
export function InstallModuleSheet({ initial, development = false, onClose }: { initial: string; development?: boolean; onClose: () => void }) {
  const previewInstall = useAction(api.modules.previewInstall);
  const install = useAction(api.modules.install);
  const previewDevelopment = useAction(api.modules.previewDevelopment);
  const installDevelopment = useAction(api.modules.installDevelopment);
  const [source, setSource] = useState(initial);
  const [drop, setDrop] = useState<string[]>([]);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // A development install's files, read from the admin's own machine.
  const [files, setFiles] = useState<{ manifest?: string; bundle?: string }>({});
  const imports = preview?.imports ?? [];

  async function onPreview() {
    setBusy(true); setError(null); setPreview(null); setDrop([]);
    try { setPreview(development ? await previewDevelopment({ manifest: files.manifest ?? "", ...(files.bundle ? { bundle: files.bundle } : {}) }) : await previewInstall({ source })); }
    catch (e) { setError(getErrorMessage(e)); } finally { setBusy(false); }
  }
  async function onInstall(p: Preview) {
    setBusy(true);
    try {
      const consent = p.upgrade ? { approveReads: p.upgrade.newReads.length > 0, drop } : {};
      const out = development
        ? await installDevelopment({ manifest: files.manifest ?? "", ...(files.bundle ? { bundle: files.bundle } : {}), manifestHash: p.manifestHash, ...consent })
        : await install({ source: p.source, sha: p.pinned.sha, manifestHash: p.manifestHash, ...consent });
      toast.success(!p.upgrade ? `${p.title} installed. Turn it on to add it to the nav.` : out.status === "upgrading" ? `${p.title}: upgrading to v${p.version}. Its data is being rebuilt.` : `${p.title} upgraded to v${p.version}.`);
      onClose();
    } catch (e) { toast.error(getErrorMessage(e)); } finally { setBusy(false); }
  }

  return (
    <Sheet open onOpenChange={(open) => { if (!open) onClose(); }}>
      <SheetContent className="w-full gap-0 overflow-y-auto sm:max-w-xl">
        <div className="border-b border-border p-4 pr-10">
          <SheetTitle className="text-base">{development ? "Install a module you're building" : "Install a module from GitHub"}</SheetTitle>
          <SheetDescription className="text-xs">{development
            ? "module.json and the bundle npx canon-module-kit build wrote. It installs as a development install, not a release; choose new files after each build to upgrade it in place."
            : "A repo, or a directory in one, holding module.json. Pinned to the commit its tag or branch names now."}</SheetDescription>
        </div>
        <div className="flex-1 space-y-6 p-4">
          {development ? (
            <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); void onPreview(); }}>
              <label className="block text-xs">module.json <input type="file" accept=".json,application/json" className="mt-1 block text-xs" aria-label="module.json"
                onChange={async (e) => { const f = e.target.files?.[0]; const text = f ? await f.text() : undefined; setPreview(null); setFiles((x) => ({ ...x, manifest: text })); }} /></label>
              <label className="block text-xs">Bundle (dist/module.js), for a module with server code <input type="file" accept=".js,.mjs,text/javascript" className="mt-1 block text-xs" aria-label="Bundle"
                onChange={async (e) => { const f = e.target.files?.[0]; const text = f ? await f.text() : undefined; setPreview(null); setFiles((x) => ({ ...x, bundle: text })); }} /></label>
              <button type="submit" className={btn} disabled={busy || !files.manifest}>{busy && !preview ? "Reading…" : "Preview"}</button>
            </form>
          ) : (
            <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); void onPreview(); }}>
              <input className="w-full border border-border bg-background px-2 py-1 font-mono text-xs" placeholder="github:owner/repo/path@v1.0.0" value={source} onChange={(e) => setSource(e.target.value)} aria-label="Module source" spellCheck={false} />
              <button type="submit" className={btn} disabled={busy || !source.trim()}>{busy && !preview ? "Reading…" : "Preview"}</button>
            </form>
          )}
          {error && <p className="text-xs text-destructive">{error}</p>}
          {preview && (
            <div className="space-y-4 text-sm">
              <div>
                <h3 className="text-base font-semibold">{preview.title} <span className="text-xs font-normal text-muted-foreground">v{preview.version}</span></h3>
                <p className="text-muted-foreground">{preview.description}</p>
                <p className="break-all font-mono text-[11px] text-muted-foreground">{preview.id} · by {preview.author} · {preview.source} · {preview.pinned.sha.slice(0, 12)}</p>
              </div>
              {preview.upgrade && <UpgradeSection upgrade={preview.upgrade} drop={drop} setDrop={setDrop} />}
              <section><h4 className={cn(heading, "mb-1")}>Nav entries</h4>{navEntries(preview).map((n) => <p key={n.href}>{n.section} · {n.label}</p>)}</section>
              <section>
                <h4 className={cn(heading, "mb-1")}>Its data</h4>
                <ul className="space-y-1">{preview.collections.map((c) => <li key={c.name}><span className="font-medium">{c.name}</span>{c.setOf ? ` (in each ${c.setOf})` : ""}: <span className="text-muted-foreground">{c.fields.join(", ")}</span></li>)}</ul>
              </section>
              {preview.reads.length > 0 && (
                <section>
                  <h4 className={cn(heading, "mb-1")}>What it reads of your workspace</h4>
                  <p className="mb-1 text-xs text-muted-foreground">Each person&apos;s use of the module reads only the records they can see. What it computes from them is stored in its data, which its own roles read.</p>
                  <ul className="space-y-1">{preview.reads.map((r) => <li key={r.object}><span className="font-medium">{({ deals: "Deals", users: "Members", teams: "Teams", companies: "Companies", people: "People", activities: "Activities", observations: "Email, LinkedIn and room touches", audiences: "Audiences", calls: "Calls and meetings", proposals: "Its own proposals", runs: "Run history", research: "Hosted research fields", records: "Records it reports on", me: "Your own world", "facts.deals": "Deal facts, with their sources and evidence", "facts.companies": "Company facts, with their sources and evidence", "facts.people": "People facts, with their sources and evidence" } as Record<string, string>)[r.object] ?? r.object}</span>: <span className="text-muted-foreground">{r.object === "records" ? recordGrants(r.fields) : r.object === "me" ? "your LinkedIn profile and posts, and metadata about people you interact with in opted-in intake and visible calls" : r.fields.join(", ")}</span></li>)}</ul>
                  {/* What was said (shared gap P11) is the most sensitive grant a module takes: its own line. */}
                  {preview.reads.some((r) => r.object === "activities" && r.fields.some((f) => f === "text" || f === "transcript" || f === "insights")) && (
                    <p className="mt-2 border-l-2 border-provenance px-2 text-xs">It reads what was said: notes, and the transcripts of recorded calls and meetings on the deals each person can see.</p>
                  )}
                  {preview.reads.some((r) => r.object === "calls" && r.fields.some((f) => f === "transcript" || f === "insights")) && (
                    <p className="mt-2 border-l-2 border-provenance px-2 text-xs">It reads call transcripts: who said what and when, on the recorded calls and meetings each person can see.</p>
                  )}
                </section>
              )}
              {(preview.feeds?.length ?? 0) > 0 && (
                <section>
                  <h4 className={cn(heading, "mb-1")}>Connector feeds it reads</h4>
                  <ul className="space-y-1">{preview.feeds.map((f) => <li key={f.name}><span className="font-medium">{f.label}</span>{f.perMember ? " · per member" : ""} · <span className="text-muted-foreground">{f.fields.join(", ")}</span></li>)}</ul>
                  {preview.feeds.some((f) => f.perMember) && <p className="text-xs text-muted-foreground">Members can turn off their own feed access in Settings → Feeds. Imported records follow this module&apos;s visibility rules and may be visible to their team. Read access does not authorize messages, calls or recordings.</p>}
                </section>
              )}
              {(preview.uses?.length ?? 0) > 0 && (
                <section>
                  <h4 className={cn(heading, "mb-1")}>What it reads of other modules</h4>
                  <p className="mb-1 text-xs text-muted-foreground">Each person reads only what that module lets them read. When it isn&apos;t installed or on, this module says so.</p>
                  <ul className="space-y-1">{preview.uses!.map((u) => <li key={`${u.module} ${u.name}`}><span className="font-medium">{u.module}</span> <span className="text-muted-foreground">{u.name}</span></li>)}</ul>
                </section>
              )}
              {(preview.provides?.length ?? 0) > 0 && (
                <section>
                  <h4 className={cn(heading, "mb-1")}>What other modules may read of it</h4>
                  <ul className="space-y-1">{preview.provides!.map((p) => <li key={p.name}><span className="font-medium">{p.name}</span>: <span className="text-muted-foreground">{p.fields.join(", ")}</span></li>)}</ul>
                </section>
              )}
              {(preview.proposes?.length ?? 0) > 0 && (
                <section>
                  <h4 className={cn(heading, "mb-1")}>What it may propose to change</h4>
                  <p className="mb-1 text-xs text-muted-foreground">It never changes these records itself. Each change waits on Patch plans until a person approves it, and a record edited since it was proposed is skipped. An admin may let it make the ones marked below without asking, for a time, after installing.</p>
                  <ul className="space-y-1">{preview.proposes!.map((p) => <li key={p.operation}><span className="font-medium">{p.label}</span> <span className="text-muted-foreground">({p.operation}){p.grantable ? `. Can be allowed without asking: ${p.grantable.toLowerCase()}` : ""}</span></li>)}</ul>
                </section>
              )}
              {(preview.outbound?.length ?? 0) > 0 && (
                <section>
                  <h4 className={cn(heading, "mb-1")}>What it may send</h4>
                  <p className="mb-1 text-xs text-muted-foreground">Nothing goes until an admin turns each channel on in Settings &gt; Outbound, where the Slack channels and webhook endpoints it names are mapped. Every message is listed there.</p>
                  <ul className="space-y-1">{preview.outbound!.map((o) => <li key={o.channel}>{o.what}</li>)}</ul>
                </section>
              )}
              {(preview.aggregates?.length ?? 0) > 0 && (
                <section>
                  <h4 className={cn(heading, "mb-1")}>Team figures</h4>
                  <p className="mb-1 text-xs text-muted-foreground">These count, sum or average every doc of a collection, the ones a person can&apos;t read too, and show only the figures, and only when the docs belong to enough people. Never a doc or one person&apos;s value.</p>
                  <ul className="space-y-1">{preview.aggregates!.map((a, i) => <li key={i}><span className="font-medium">{a.call}</span>: <span className="text-muted-foreground">{a.collection}, from at least {a.minOwners} people</span></li>)}</ul>
                </section>
              )}
              {imports.length > 0 && (
                <section>
                  <h4 className={cn(heading, "mb-1")}>Imports from Canon</h4>
                  <ul className="space-y-1">{imports.map((i) => <li key={i.name}>{i.label}. <span className="text-muted-foreground">Runs once for this workspace.</span></li>)}</ul>
                </section>
              )}
              {preview.server && (
                <section>
                  <h4 className={cn(heading, "mb-1")}>Its code</h4>
                  <p className="text-xs text-muted-foreground">{preview.server.path}, {Math.ceil(preview.server.bytes / 1024)} KB, runs in Canon&apos;s sandbox with no network: {preview.calls.map((c) => c.label).join(", ")}.</p>
                </section>
              )}
              <section>
                <h4 className={cn(heading, "mb-1")}>What agents can do</h4>
                <ul className="space-y-1">{preview.ops.map((o) => <li key={o.name}>{o.label}: <span className="text-muted-foreground">{o.agent === "allowed" ? "an agent can, as its person" : o.agent === "propose" ? "an agent proposes it" : "a person only"}</span></li>)}</ul>
              </section>
            </div>
          )}
        </div>
        {preview && (
          <div className="sticky bottom-0 flex items-center justify-between gap-2 border-t border-border bg-background p-3 text-xs">
            <span className="text-muted-foreground">{installNote(preview, drop)}</span>
            <button type="button" className={primary} disabled={busy || !(preview.upgrade ? upgradable(preview, drop) : preview.canInstall && preview.installed === null)} onClick={() => void onInstall(preview)}>
              {preview.upgrade ? `Upgrade to v${preview.version}` : "Install"}
            </button>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

/** Whether the previewed version can upgrade the installed one now, with the collections ticked for deletion. */
function upgradable(p: Preview, drop: readonly string[]): boolean {
  const u = p.upgrade;
  return !!u && p.canInstall && (u.kept || p.installed?.sameSource === true) && !u.older && !u.sameCommit && !u.running && !u.problems.length && u.dropped.every((c) => drop.includes(c));
}

/** The line beside the install button: why it can't install, or what it will do. */
function installNote(p: Preview, drop: readonly string[]): string {
  if (!p.canInstall) return "Admins and managers install modules.";
  const u = p.upgrade;
  if (!u) return p.installed ? `Already installed: v${p.installed.version} from ${p.installed.source}.` : `Installs v${p.version} at ${p.pinned.sha.slice(0, 12)}.`;
  if (!u.kept && !p.installed?.sameSource) return `Installed from ${p.installed?.source}. Uninstall it to install from another source.`;
  if (u.running) return `An upgrade to v${u.running} is running.`;
  if (u.sameCommit) return `Already installed at this commit (v${u.from}).`;
  if (u.older) return `v${p.version} is older than the installed v${u.from}.`;
  if (u.problems.length) return "This version can't upgrade the installed one in place.";
  if (!upgradable(p, drop)) return "Tick each collection it removes to confirm.";
  return u.kept ? `Installs v${p.version} at ${p.pinned.sha.slice(0, 12)} over the data v${u.from} kept when it was uninstalled.` : `Upgrades v${u.from} to v${p.version} at ${p.pinned.sha.slice(0, 12)}. Its data stays.`;
}

/** What upgrading does: what it newly reads (approved by upgrading), the data it rebuilds, and what it removes. */
function UpgradeSection({ upgrade: u, drop, setDrop }: { upgrade: NonNullable<Preview["upgrade"]>; drop: string[]; setDrop: (d: string[]) => void }) {
  const rebuilt = [...new Set([...u.reindexed, ...u.rechecked])].filter((c) => !u.migrated.includes(c));
  return (
    <section className="space-y-2 border border-border p-3">
      <h4 className={heading}>{u.kept ? `Upgrade the data v${u.from} kept` : `Upgrade from v${u.from}`}</h4>
      {u.problems.length > 0 && <ul className="list-disc pl-4 text-xs text-destructive">{u.problems.map((x) => <li key={x}>{x}</li>)}</ul>}
      {u.newReads.length > 0 && <p className="text-xs"><span className="font-medium">It reads more of your workspace:</span> {u.newReads.join(", ")}. Upgrading approves it.</p>}
      {rebuilt.length > 0 && (
        <p className="text-xs text-muted-foreground">It rebuilds {rebuilt.join(", ")}: every doc is checked against the new version and indexed for it, in the background. v{u.from} serves until that is done.</p>
      )}
      {u.migrated.length > 0 && (
        <p className="text-xs text-muted-foreground">It migrates {u.migrated.join(", ")}: the module&apos;s own migration rewrites each doc, checked against the new version, in the background. v{u.from} serves until that is done, and its data is read only meanwhile. A doc that fails stops the upgrade, named, and v{u.from} keeps serving.</p>
      )}
      {u.dropped.map((c) => (
        <label key={c} className="flex items-center gap-2 text-xs">
          <input type="checkbox" checked={drop.includes(c)} onChange={(e) => setDrop(e.target.checked ? [...drop, c] : drop.filter((x) => x !== c))} />
          It removes {c}. Delete its docs.
        </label>
      ))}
      {!u.problems.length && !u.newReads.length && !u.reindexed.length && !u.rechecked.length && !u.dropped.length && !u.migrated.length && <p className="text-xs text-muted-foreground">Its data stays as it is.</p>}
    </section>
  );
}
