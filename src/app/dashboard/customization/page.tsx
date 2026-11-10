"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAction, useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { ChevronRight, Copy, FilePenLine, Github, MoreHorizontal, RefreshCw, SlidersHorizontal, Trash2 } from "lucide-react";
import { api } from "../../../../convex/_generated/api";
import { LoadingRows, ViewFrame } from "@/components/dashboard";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { toast } from "@/lib/toast";
import { cn, getErrorMessage } from "@/lib/utils";
import { pageRows, type PageRow } from "./page-map";
import { PointRow, type Offered } from "./point-row";
import { GithubConnections } from "./recipe-github";
import { CanonModules, InstallModuleSheet, InstalledModules } from "./recipe-modules";
import { InstallSheet, UpgradeSheet, permissionLines } from "./recipe-packages";
import { RecipeSettingsSheet } from "./recipe-settings";

type View = NonNullable<FunctionReturnType<typeof api.recipes.forOrg>>;
type Recipe = View["available"][number];
type PointView = View["points"][number];
type Tab = "applied" | "browse";

const btn = "inline-flex items-center gap-1 border border-border px-2 py-1 text-xs font-medium hover:bg-muted disabled:opacity-50";
const primary = cn(btn, "border-primary bg-primary text-primary-foreground hover:bg-primary/90");
const tag = "inline-flex items-center border border-border px-1.5 py-0.5 text-xs font-medium text-muted-foreground";
const list = "divide-y divide-border border border-border bg-card";

/** The editor's route. Every workspace recipe is @workspace/<name>, so the route carries only the name. */
const editHref = (id: string) => `/dashboard/customization/${encodeURIComponent(id.split("/").pop()!)}/edit`;

/**
 * The tab, kept in ?tab= so GitHub's return and a shared link land on Browse. Read once on mount: everything that
 * depends on it waits for the workspace's data, which the server never renders, so hydration can't disagree.
 */
function useTab(): [Tab, (t: Tab) => void] {
  const [tab, setTab] = useState<Tab>(() => (typeof window !== "undefined" && new URLSearchParams(window.location.search).get("tab") === "browse" ? "browse" : "applied"));
  return [tab, (t) => {
    setTab(t);
    const url = new URL(window.location.href);
    if (t === "browse") url.searchParams.set("tab", "browse"); else url.searchParams.delete("tab");
    window.history.replaceState(null, "", url);
  }];
}

/**
 * Customization (docs/customization.md): what this workspace has applied, its modules and the pages it changed, and
 * what it can add. A module brings its own pages; a package (docs/recipes.md) changes Canon's pages. Admins and
 * managers change them; agents read all of it over /mcp.
 */
export default function CustomizationPage() {
  const view = useQuery(api.recipes.forOrg);
  const modules = useQuery(api.modules.installed);
  const enable = useMutation(api.recipes.enableContribution);
  const disable = useMutation(api.recipes.disableContribution);
  const uninstall = useMutation(api.recipes.uninstall);
  const customize = useAction(api.workspaceRecipes.customize);
  const router = useRouter();
  const [tab, setTab] = useTab();
  const [busy, setBusy] = useState(false);
  const [page, setPage] = useState<{ label: string; ids: string[] } | null>(null);
  const [installing, setInstalling] = useState(false);
  const [installingModule, setInstallingModule] = useState<string | null>(null);
  const [developing, setDeveloping] = useState(false);
  const [updating, setUpdating] = useState<{ id: string; title: string } | null>(null);
  const [editing, setEditing] = useState<{ id: string; title: string } | null>(null);

  async function run(change: () => Promise<unknown>, done: string) {
    setBusy(true);
    try {
      await change();
      toast.success(done);
    } catch (error) {
      toast.error(getErrorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  const frame = {
    title: "Customization",
    description: "What this workspace runs, and what you can add.",
  };
  if (view === undefined) return <ViewFrame {...frame}><LoadingRows count={3} height="h-28" /></ViewFrame>;
  if (view === null) return <ViewFrame {...frame}>{null}</ViewFrame>;

  const { pages, workspace } = pageRows(view.points);
  const changed = pages.filter((p) => p.applied.length);
  const unchanged = pages.filter((p) => !p.applied.length);
  const modulePages = (modules?.modules ?? []).flatMap((m) => (m.enabled && m.nav ? [{ ...m, nav: m.nav }] : []));
  const point = (id: string) => view.points.find((p) => p.id === id);
  const inForce = (id: string) => point(id)?.contributions.find((c) => c.enabled)?.recipeTitle ?? "Canon's default";
  const usedAt = (r: Recipe) => view.points.flatMap((p) => (p.contributions.some((c) => c.recipeId === r.id && c.enabled) ? [p.title] : []));
  const offered = pages.filter((p) => p.offered > 0);
  const onCustomize = (r: { id: string; title: string }) =>
    void run(async () => router.push(editHref((await customize({ recipeId: r.id })).recipeId)), `Made a copy of ${r.title} for this workspace`);

  return (
    <ViewFrame {...frame}>
      <div role="tablist" aria-label="Customization" className="mb-6 flex gap-5 border-b border-border">
        {([["applied", "Applied"], ["browse", "Browse"]] as const).map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)}
            className={cn("-mb-px border-b-2 px-0.5 pb-2 text-sm", tab === id ? "border-primary font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")}>{label}</button>
        ))}
      </div>

      {tab === "applied" ? (
        <>
          <dl className="mb-8 grid grid-cols-2 gap-px border border-border bg-border md:grid-cols-4">
            <Stat label="Modules on" value={modules ? `${modules.modules.filter((m) => m.enabled).length} of ${modules.modules.length}` : "…"} />
            <Stat label="Pages changed" value={`${changed.length} of ${pages.length}`} />
            <Stat label="Theme" value={inForce("workspace.theme")} />
            <Stat label="Customizations" value={String(view.available.length)} />
          </dl>

          <Section title="Modules" count={modules?.modules.length} action={view.canEdit && <button type="button" className={btn} onClick={() => setTab("browse")}>Add a module</button>}>
            <InstalledModules onInstall={setInstallingModule} onBrowse={() => setTab("browse")} />
          </Section>

          <Section title="Pages" count={changed.length + modulePages.length} note={changed.length || modulePages.length ? undefined : "Every page runs as Canon ships it."}>
            {(changed.length > 0 || modulePages.length > 0) && (
              <ul className={list}>
                {changed.map((p) => <PageLine key={p.id} page={p} onCustomize={() => setPage({ label: p.label, ids: p.points.map((x) => x.id) })} />)}
                {modulePages.map((m) => (
                  <li key={m.moduleId} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-4 py-3 sm:grid-cols-[11rem_minmax(0,1fr)_auto]">
                    <Link href={m.nav.href} className="text-sm font-medium hover:underline">{m.nav.label}</Link>
                    <span className="col-span-2 row-start-2 flex flex-wrap gap-1.5 sm:col-span-1 sm:row-start-auto"><span className={tag}>{m.title} module · {m.pages} {m.pages === 1 ? "page" : "pages"}</span></span>
                    <Link href={m.nav.href} className={btn}>Open</Link>
                  </li>
                ))}
              </ul>
            )}
            {unchanged.length > 0 && (
              <details className="group mt-2">
                <summary className="flex cursor-pointer list-none items-center gap-1.5 py-2 text-xs text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
                  <ChevronRight className="h-3.5 w-3.5 transition-transform group-open:rotate-90" />{unchanged.length} pages as Canon ships them
                </summary>
                <ul className={list}>
                  {unchanged.map((p) => <PageLine key={p.id} page={p} onCustomize={() => setPage({ label: p.label, ids: p.points.map((x) => x.id) })} />)}
                </ul>
              </details>
            )}
          </Section>

          <Section title="Every page">
            <WorkspaceShape canEdit={view.canEdit} rows={[
              { title: "Theme", value: inForce("workspace.theme"), onClick: () => setPage({ label: "Theme", ids: ["workspace.theme"] }) },
              { title: "Navigation", value: workspace.applied.some((a) => a.point === "workspace.nav") ? inForce("workspace.nav") : "Canon's default", onClick: () => setPage({ label: "Navigation", ids: ["workspace.nav"] }) },
            ]} />
          </Section>

          <Section title="Customizations" count={view.available.length} note="Sets of page changes: layouts, a model's numbers, the theme.">
            <ul className={list}>
              {view.available.map((r) => (
                <PackageRow key={r.id} r={r} usedAt={usedAt(r)} canEdit={view.canEdit} busy={busy}
                  onSettings={() => setEditing({ id: r.id, title: r.title })}
                  onUpdates={() => setUpdating({ id: r.id, title: r.title })}
                  onUninstall={() => void run(() => uninstall({ recipeId: r.id }), `${r.title} uninstalled`)}
                  onCustomize={() => onCustomize(r)} />
              ))}
            </ul>
          </Section>
        </>
      ) : (
        <>
          <Section title="Modules from Canon" note="Each adds its own pages under one nav entry.">
            <CanonModules onUpgrade={setInstallingModule} />
          </Section>

          {offered.length > 0 && (
            <Section title="For your pages" note="Things your customizations offer that aren't on yet.">
              <ul className={list}>
                {offered.map((p) => (
                  <li key={p.id} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-4 py-3">
                    <span className="min-w-0 text-sm"><span className="font-medium">{p.label}</span> <span className="text-muted-foreground">· {p.offered} not on</span></span>
                    <button type="button" className={btn} onClick={() => setPage({ label: p.label, ids: p.points.map((x) => x.id) })}>View</button>
                  </li>
                ))}
              </ul>
            </Section>
          )}

          <Section title="From GitHub">
            <div className="grid gap-3 md:grid-cols-2">
              <GithubCard title="A module" source="module.json" action="Preview a module" canEdit={view.canEdit} onClick={() => setInstallingModule("")} />
              <GithubCard title="A customization" source="customization.md" action="Preview a customization" canEdit={view.canEdit} onClick={() => setInstalling(true)} />
            </div>
            {modules?.developmentInstalls && (
              <div className="mt-3 flex items-center justify-between gap-3 border border-dashed border-border bg-card px-4 py-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium">A module you're building</p>
                  <p className="text-xs text-muted-foreground">Its module.json and bundle from this computer, as a development install. Self-hosted Canon only.</p>
                </div>
                {view.canEdit ? <button type="button" className={btn} onClick={() => setDeveloping(true)}>Choose files</button> : <span className="text-xs text-muted-foreground">Admins and managers</span>}
              </div>
            )}
            <div className="mt-3 border border-border bg-card px-4 pb-4"><GithubConnections /></div>
          </Section>
        </>
      )}

      <PageSheet page={page} points={page ? page.ids.flatMap((id) => point(id) ?? []) : []} available={view.available} canEdit={view.canEdit} busy={busy}
        onOpenChange={(open) => { if (!open) setPage(null); }}
        onSettings={(c) => setEditing({ id: c.recipeId, title: c.recipeTitle })}
        onCustomize={onCustomize}
        onEnable={(p, c) => run(() => enable({ point: p.id, recipeId: c.recipeId, key: c.key }), p.cardinality === "exclusive" ? `${p.title} now runs ${c.recipeTitle}` : c.install?.state === "none" ? `${c.title} installed` : `${c.title} turned on`)}
        onDisable={(p, c) => run(() => disable({ point: p.id, recipeId: c.recipeId, key: c.key }), p.cardinality === "exclusive" ? `${c.recipeTitle} turned off` : `${c.title} turned off`)} />
      <RecipeSettingsSheet recipe={editing} onOpenChange={(open) => { if (!open) setEditing(null); }} />
      <InstallSheet open={installing} onOpenChange={setInstalling} canEdit={view.canEdit} />
      <UpgradeSheet recipe={updating} onOpenChange={(open) => { if (!open) setUpdating(null); }} canEdit={view.canEdit} />
      {installingModule !== null && <InstallModuleSheet initial={installingModule} onClose={() => setInstallingModule(null)} />}
      {developing && <InstallModuleSheet initial="" development onClose={() => setDeveloping(false)} />}
    </ViewFrame>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 bg-card px-4 py-3">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-1 truncate font-display text-xl font-semibold tabular-nums">{value}</dd>
    </div>
  );
}

function Section({ title, count, note, action, children }: { title: string; count?: number; note?: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="mb-8">
      <div className="mb-2 flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold">{title}{count !== undefined && <span className="ml-1.5 font-normal tabular-nums text-muted-foreground">{count}</span>}</h2>
          {note && <p className="mt-0.5 text-xs text-muted-foreground">{note}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

/** A Canon page: what is applied to it, and Customize. */
function PageLine({ page, onCustomize }: { page: PageRow; onCustomize: () => void }) {
  return (
    <li className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1.5 px-4 py-3 sm:grid-cols-[11rem_minmax(0,1fr)_auto]">
      <Link href={page.href} className="text-sm font-medium hover:underline">{page.label}</Link>
      <span className="col-span-2 row-start-2 flex flex-wrap gap-1.5 sm:col-span-1 sm:row-start-auto">
        {page.applied.length
          ? page.applied.map((a) => <span key={a.point} className={cn(tag, "text-foreground")}>{a.title}: {a.by}</span>)
          : <span className="text-xs text-muted-foreground">As Canon ships it</span>}
      </span>
      <button type="button" className={btn} onClick={onCustomize}>Customize</button>
    </li>
  );
}

/** What changes every page: the theme and the navigation, then the workspace's pipelines and objects on their own pages. */
function WorkspaceShape({ canEdit, rows }: { canEdit: boolean; rows: Array<{ title: string; value: string; onClick: () => void }> }) {
  const pipelines = useQuery(api.pipelines.list);
  const objects = useQuery(api.dataModel.objects);
  const custom = objects?.filter((o) => o.custom).length ?? 0;
  const fields = objects?.reduce((sum, o) => sum + o.customFields, 0) ?? 0;
  const links = [
    { href: "/dashboard/customization/data-model", title: "Data model", value: objects ? `${custom} own object${custom === 1 ? "" : "s"} · ${fields} custom field${fields === 1 ? "" : "s"}` : null },
    ...(canEdit ? [{ href: "/dashboard/customization/pipelines", title: "Pipelines", value: pipelines ? `${pipelines.length} pipeline${pipelines.length === 1 ? "" : "s"}` : null }] : []),
  ];
  const line = "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-4 py-3 sm:grid-cols-[11rem_minmax(0,1fr)_auto]";
  return (
    <ul className={list}>
      {rows.map((r) => (
        <li key={r.title} className={line}>
          <span className="text-sm font-medium">{r.title}</span>
          <span className="col-span-2 row-start-2 text-xs text-muted-foreground sm:col-span-1 sm:row-start-auto">{r.value}</span>
          <button type="button" className={btn} onClick={r.onClick}>Customize</button>
        </li>
      ))}
      {links.map((l) => (
        <li key={l.href}>
          <Link href={l.href} className={cn(line, "hover:bg-muted/40")}>
            <span className="text-sm font-medium">{l.title}</span>
            <span className="col-span-2 row-start-2 text-xs text-muted-foreground sm:col-span-1 sm:row-start-auto">{l.value ?? <span className="inline-block h-3 w-20 animate-pulse bg-muted" />}</span>
            <span className={btn}>Edit<ChevronRight className="h-3.5 w-3.5" /></span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

function GithubCard({ title, source, action, canEdit, onClick }: { title: string; source: string; action: string; canEdit: boolean; onClick: () => void }) {
  return (
    <div className="flex items-center justify-between gap-3 border border-border bg-card px-4 py-3">
      <div className="min-w-0">
        <p className="text-sm font-medium">{title}</p>
        <p className="font-mono text-[11px] text-muted-foreground">github:owner/repo · {source}</p>
      </div>
      {canEdit ? <button type="button" className={btn} onClick={onClick}><Github className="h-3.5 w-3.5" />{action}</button> : <span className="text-xs text-muted-foreground">Admins and managers</span>}
    </div>
  );
}

/** An installed package: its source, version and where it is in use, one action, and its details on demand. */
function PackageRow({ r, usedAt, canEdit, busy, onSettings, onUpdates, onUninstall, onCustomize }: {
  r: Recipe; usedAt: string[]; canEdit: boolean; busy: boolean; onSettings: () => void; onUpdates: () => void; onUninstall: () => void; onCustomize: () => void;
}) {
  const [open, setOpen] = useState(false);
  const own = r.source?.workspace ?? false;
  const github = !!r.source && !own;
  const more = [
    ...(r.hasSettings ? [{ label: `Settings${r.revision !== null ? ` · rev ${r.revision}` : ""}`, icon: SlidersHorizontal, run: onSettings }] : []),
    ...(github && canEdit ? [{ label: "Check for updates", icon: RefreshCw, run: onUpdates }] : []),
    ...(r.source && canEdit ? [{ label: "Uninstall", icon: Trash2, run: onUninstall, disabled: usedAt.length > 0 }] : []),
  ];
  return (
    <li>
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-4 py-3">
        <button type="button" aria-expanded={open} className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-left" onClick={() => setOpen(!open)}>
          <ChevronRight className={cn("h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />
          <span className="text-sm font-medium">{r.title}</span>
          <span className={tag}>v{r.version}</span>
          <span className={tag}>{own ? "This workspace" : r.source ? (r.source.private ? "Private repo" : "GitHub") : "Canon"}</span>
          <span className="text-xs text-muted-foreground">{usedAt.length ? `In use on ${usedAt.length}` : "Not in use"}</span>
          {r.upstream && <span className={cn(tag, "border-warning text-warning")}>v{r.upstream.version} upstream</span>}
        </button>
        <span className="flex shrink-0 items-center gap-2">
          {r.proposals > 0
            ? <button type="button" className={primary} onClick={onSettings}>Review {r.proposals}</button>
            : own
              ? <Link className={primary} href={editHref(r.id)}><FilePenLine className="h-3.5 w-3.5" />{canEdit ? "Edit" : "View"}</Link>
              : canEdit && <button type="button" className={btn} disabled={busy} title="Make this workspace its own copy to edit" onClick={onCustomize}><Copy className="h-3.5 w-3.5" />Customize</button>}
          {more.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild><button type="button" className={btn} aria-label={`More for ${r.title}`}><MoreHorizontal className="h-3.5 w-3.5" /></button></DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="rounded-none">
                {more.map((m) => (
                  <DropdownMenuItem key={m.label} className="rounded-none text-xs" disabled={busy || ("disabled" in m && m.disabled)} onSelect={m.run}
                    title={"disabled" in m && m.disabled ? `Pick another customization for ${usedAt.join(" and ")} first` : undefined}>
                    <m.icon className="h-3.5 w-3.5" />{m.label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </span>
      </div>
      {open && (
        <div className="space-y-2 border-t border-border px-4 py-3 sm:pl-9">
          <p className="max-w-[72ch] text-sm text-muted-foreground">{r.description}</p>
          {r.upstream && (
            <p className="text-xs text-warning">{r.upstream.title} is at v{r.upstream.version}; this copy took v{r.upstream.from}. <Link className="underline" href={editHref(r.id)}>Merge it in the editor</Link></p>
          )}
          <p className="break-all font-mono text-[11px] text-muted-foreground">
            by {r.author.org}{own ? ` · ${r.source!.text}` : r.source ? ` · ${r.source.text} · ${r.source.sha.slice(0, 12)}` : " · updates with Canon"}
          </p>
          {usedAt.length > 0 && <p className="text-xs text-muted-foreground">In use on {usedAt.join(", ")}</p>}
          <div className="flex flex-wrap gap-1.5">
            {permissionLines(r.permissions).map((l) => <span key={l} className={tag}>{l}</span>)}
          </div>
        </div>
      )}
    </li>
  );
}

/** One page's points in a sheet: what each runs, switches for what can be on, and editing the page's layout. */
function PageSheet({ page, points, available, canEdit, busy, onOpenChange, onSettings, onCustomize, onEnable, onDisable }: {
  page: { label: string } | null; points: PointView[]; available: Recipe[]; canEdit: boolean; busy: boolean; onOpenChange: (open: boolean) => void;
  onSettings: (c: Offered) => void; onCustomize: (r: { id: string; title: string }) => void;
  onEnable: (p: PointView, c: Offered) => Promise<void>; onDisable: (p: PointView, c: Offered) => Promise<void>;
}) {
  const layout = points.find((p) => p.kind === "page");
  const on = layout?.contributions.find((c) => c.enabled);
  const pkg = on && available.find((r) => r.id === on.recipeId);
  return (
    <Sheet open={page !== null} onOpenChange={onOpenChange}>
      <SheetContent className="w-full gap-0 overflow-y-auto sm:max-w-xl">
        <div className="border-b border-border p-4 pr-10">
          <SheetTitle className="text-base">{page?.label}</SheetTitle>
          <SheetDescription className="text-xs">{canEdit ? "What runs here, for everyone in the workspace." : "What runs here. Admins and managers change it."}</SheetDescription>
        </div>
        {layout && pkg && canEdit && (
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3 text-xs">
            <span className="text-muted-foreground">Layout from {pkg.title}</span>
            {pkg.source?.workspace
              ? <Link className={primary} href={editHref(pkg.id)}><FilePenLine className="h-3.5 w-3.5" />Edit layout</Link>
              : <button type="button" className={primary} disabled={busy} onClick={() => onCustomize(pkg)}><Copy className="h-3.5 w-3.5" />Copy and edit</button>}
          </div>
        )}
        <div className="divide-y divide-border">
          {points.map((p) => (
            <PointRow key={p.id} point={p} open canEdit={canEdit} busy={busy} onSettings={onSettings}
              onEnable={(c) => onEnable(p, c)} onDisable={(c) => onDisable(p, c)} />
          ))}
        </div>
      </SheetContent>
    </Sheet>
  );
}
