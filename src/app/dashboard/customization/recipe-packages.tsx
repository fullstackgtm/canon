"use client";

import { IntegrationGate } from "@/components/integration-gate";

import { useEffect, useState } from "react";
import { useAction } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "../../../../convex/_generated/api";
import { POINTS, type AnyDescriptor, type PageComponent, type Permissions, type SettingValue } from "../../../../recipes";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { toast } from "@/lib/toast";
import { cn, getErrorMessage } from "@/lib/utils";
import { EvalResults, shown } from "./recipe-settings";

type Preview = FunctionReturnType<typeof api.recipes.previewInstall>;
type Upgrade = FunctionReturnType<typeof api.recipes.checkUpgrade>;
type Line = NonNullable<Upgrade["lines"]>[number];

const btn = "inline-flex items-center gap-1 border border-border px-2 py-1 text-xs font-medium hover:bg-muted disabled:opacity-50";
const primary = cn(btn, "border-foreground bg-foreground text-background hover:bg-foreground/90");
const input = "border border-border bg-background px-2 py-1 text-sm";
const heading = "mb-2 text-xs font-medium text-muted-foreground";

const SECTION_LABEL: Record<PageComponent, string> = {
  queue: "Deal queue", summary: "Summary", stageRail: "Stage rail", fanOut: "Find the way in", prep: "Prep", plan: "Plan",
  keeper: "Keeper", brief: "Brief", accountMap: "Account map", touches: "Touches", fieldGrid: "Every field",
  fields: "Fields", timeline: "Timeline", history: "History", related: "Related records", products: "Products", splits: "Credit splits", apps: "Apps",
  header: "Name and actions", fitBar: "Fit bar", whyFit: "Why this fit", scoreHistory: "Score history", topSignals: "Top signals",
  companyDeals: "Deals", peopleAcrossDeals: "People across deals", aiFields: "AI fields", callPanel: "Calls", composeEmail: "Email",
};
/** A section an upgrade adds or drops, as checkUpgrade names it: `whyFit` on the deal page, `account.whyFit` on another page. */
function sectionChange(x: string): { label: string; page: string } {
  const [page, component] = x.includes(".") ? x.split(".") : ["deal", x];
  return { label: SECTION_LABEL[component as PageComponent] ?? component, page };
}
const OBJECT_LABEL: Record<Permissions["read"][number], string> = { deal: "deals", contact: "people", account: "companies", observations: "observations", icps: "ICPs" };
const SOURCE_LABEL: Record<Permissions["sources"][number], string> = { web_search: "web search", read_site: "reading web pages" };

const short = (sha: string) => sha.slice(0, 12);

export function permissionLines(p: Permissions): string[] {
  return [
    ...(p.read.length ? [`Reads ${p.read.map((x) => OBJECT_LABEL[x]).join(", ")}`] : []),
    ...p.slots.map((point) => `Fills the ${POINTS[point].title.toLowerCase()}`),
    ...(p.llm === "owner" ? ["Runs prompts on the rep's own model plan"] : []),
    ...(p.sources.length ? [`Researches with ${p.sources.map((x) => SOURCE_LABEL[x]).join(" and ")}`] : []),
  ];
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return <section><h3 className={heading}>{title}</h3>{children}</section>;
}

const PLAY_LABEL: Record<string, string> = {
  "drafts.prompt": "First-touch prompt", "drafts.reviewPrompt": "Draft review prompt", "research.planPrompt": "Research search plan", "research.briefPrompt": "Account plan prompt",
  "people.capability.prompt": "Capability prompt", stage: "Stage", keeper: "Keeper flags", prep: "Prep", fanOut: "Who to reach first", pointOfView: "Point of view",
  "drafts.check": "Draft checks", "people.productContext": "Product context", "people.capability.clean": "Capability answers",
};

/**
 * Install a recipe from a GitHub repo (docs/recipes.md, R5), public or private through a connected GitHub account:
 * preview what the source's ref points at now, pinned to that commit, with what it asks for, which parts are markdown
 * and which are code, the settings it exposes and its evals, then install it. A pasted recipe.md previews the same way.
 */
function InstallSheetEnabled({ open, onOpenChange, canEdit }: { open: boolean; onOpenChange: (open: boolean) => void; canEdit: boolean }) {
  const previewInstall = useAction(api.recipes.previewInstall);
  const install = useAction(api.recipes.install);
  const [source, setSource] = useState("");
  const [pasting, setPasting] = useState(false);
  const [markdown, setMarkdown] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onPreview() {
    setBusy(true); setError(null); setPreview(null);
    try { setPreview(await previewInstall(pasting ? { markdown } : { source })); } catch (e) { setError(getErrorMessage(e)); } finally { setBusy(false); }
  }
  async function onInstall(p: Preview) {
    if (!p.source || !p.pinned) return;
    setBusy(true);
    try {
      await install({ source: p.source, sha: p.pinned.sha, bundleHash: p.bundleHash });
      toast.success(`${p.title} installed. Pick it on the page it changes to use it.`);
      onOpenChange(false); setPreview(null); setSource("");
    } catch (e) { toast.error(getErrorMessage(e)); } finally { setBusy(false); }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full gap-0 overflow-y-auto sm:max-w-xl">
        <div className="border-b border-border p-4 pr-10">
          <SheetTitle className="text-base">Install a customization from GitHub</SheetTitle>
          <SheetDescription className="text-xs">A public repo, or a private one in a GitHub account connected below. Pinned to the commit its tag or branch names now.</SheetDescription>
        </div>
        <div className="flex-1 space-y-6 p-4">
          <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); void onPreview(); }}>
            {pasting ? (
              <textarea className={cn(input, "h-40 w-full font-mono text-xs")} placeholder={"---\nid: \"@agency/customization-name\"\n..."} value={markdown} onChange={(e) => setMarkdown(e.target.value)} aria-label="recipe.md" spellCheck={false} />
            ) : (
              <input className={cn(input, "w-full font-mono text-xs")} placeholder="github:owner/repo/path@v1.0.0" value={source} onChange={(e) => setSource(e.target.value)} aria-label="Customization source" spellCheck={false} />
            )}
            <div className="flex items-center justify-between gap-2">
              <button type="button" className="text-xs text-muted-foreground underline-offset-2 hover:underline" onClick={() => { setPasting(!pasting); setPreview(null); setError(null); }}>
                {pasting ? "Preview from GitHub instead" : "Or paste a customization.md to preview it"}
              </button>
              <button type="submit" className={btn} disabled={busy || !(pasting ? markdown : source).trim()}>{busy && !preview ? "Reading…" : "Preview"}</button>
            </div>
          </form>
          {error && <p className="text-xs text-destructive">{error}</p>}
          {preview && <PreviewBody p={preview} />}
        </div>
        {preview && (
          <div className="sticky bottom-0 flex items-center justify-between gap-2 border-t border-border bg-background p-3 text-xs">
            <span className="text-muted-foreground">
              {!preview.pinned ? "A pasted customization.md only previews. Publish it to GitHub to install it."
                : preview.installed ? `Already installed: v${preview.installed.version} from ${preview.installed.source}.`
                : !canEdit || !preview.canInstall ? "Admins and managers install customizations." : `Installs v${preview.version} at ${short(preview.pinned.sha)}.`}
            </span>
            <button type="button" className={primary} disabled={busy || !canEdit || !preview.canInstall || preview.installed !== null} onClick={() => void onInstall(preview)}>Install</button>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

/** Which of a recipe's plays are written in its recipe.md, run on Canon's built-ins, or run as its code. */
function Parts({ p }: { p: Pick<Preview, "parts" | "hasCode"> }) {
  const group = (from: Preview["parts"][number]["from"]) => p.parts.filter((x) => x.from === from);
  const rows: Array<[string, Preview["parts"]]> = [
    ["Written in customization.md", group("prompt")],
    ["Canon built-ins, set up in customization.md", group("builtin")],
    ["Code in dist/customization.js", group("code")],
  ];
  return (
    <Section title="Markdown and code">
      <p className="mb-2 text-xs text-muted-foreground">
        {p.hasCode ? "Its settings, page, prompts and evals are markdown. The logic below marked as code is TypeScript, bundled in dist/customization.js." : "Markdown only: no code ships. Its settings, page, prompts and evals are customization.md, and its logic is Canon's built-ins."}
      </p>
      <dl className="space-y-2 text-xs">
        {rows.filter(([, xs]) => xs.length).map(([label, xs]) => (
          <div key={label}>
            <dt className="font-medium">{label}</dt>
            <dd className="text-muted-foreground">{xs.map((x) => `${PLAY_LABEL[x.play] ?? x.play}${x.from === "prompt" ? "" : ` (${x.name})`}`).join(" · ")}</dd>
          </div>
        ))}
      </dl>
    </Section>
  );
}

function PreviewBody({ p }: { p: Preview }) {
  const schema = p.schema as readonly AnyDescriptor[];
  const defaults = p.defaults as Record<string, SettingValue>;
  const groups = [...new Set(schema.map((d) => d.group))];
  const passing = p.evals.filter((e) => e.ok).length;
  return (
    <>
      <div className="space-y-1">
        <p className="text-sm font-medium">{p.title} <span className="text-xs font-medium text-muted-foreground">· by {p.author.org} · v{p.version}</span></p>
        <p className="text-sm text-muted-foreground">{p.description}</p>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 pt-2 font-mono text-[11px]">
          <dt className="text-muted-foreground">Package</dt><dd className="break-all">{p.id}</dd>
          <dt className="text-muted-foreground">Source</dt><dd className="break-all">{p.source ?? "a pasted customization.md"}{p.private ? " · private, read through Canon's GitHub App" : ""}</dd>
          {p.pinned && <><dt className="text-muted-foreground">Pinned commit</dt><dd className="break-all">{p.pinned.sha}</dd></>}
          <dt className="text-muted-foreground">Bundle</dt><dd className="break-all">{p.bundleHash} · {Math.ceil(p.bundleBytes / 1024)} KB{p.hasCode ? "" : " · Canon's built-ins"}</dd>
        </dl>
      </div>
      <Section title="It asks to">
        <ul className="list-disc space-y-0.5 pl-4 text-xs">{permissionLines(p.permissions).map((l) => <li key={l}>{l}</li>)}</ul>
        <p className="mt-2 text-xs text-muted-foreground">Its code runs only in Canon&apos;s sandbox, with no network and no secrets. It returns data; every write still goes through Canon&apos;s own checks.</p>
      </Section>
      <Parts p={p} />
      {([["Deal page", p.dealPage], ["Account page", p.accountPage], ["Contact page", p.contactPage]] as const).filter(([, page]) => page.length > 0).map(([name, page]) => (
        <Section key={name} title={`${name} it fills`}>
          <p className="text-xs">{page.map((s) => (s.component === "fields" ? s.title : SECTION_LABEL[s.component])).join(" · ")}</p>
        </Section>
      ))}
      <Section title={`Settings it exposes · ${schema.length}`}>
        <div className="space-y-3">
          {groups.map((g) => (
            <div key={g}>
              <p className="text-xs font-medium">{g}</p>
              <ul className="space-y-0.5 text-xs">
                {schema.filter((d) => d.group === g).map((d) => (
                  <li key={d.key} className="flex gap-2"><span className="shrink-0 text-muted-foreground">{d.label}:</span><span className="min-w-0 truncate">{shown(defaults[d.key])}</span></li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </Section>
      <Section title={`Evals · ${passing} of ${p.evals.length} pass`}>
        <EvalResults evals={p.evals} />
      </Section>
    </>
  );
}

function LineText({ line, label }: { line: Line; label: string }) {
  const k = <span className="text-muted-foreground">{label}:</span>;
  switch (line.kind) {
    case "takesDefault": return <>{k} {shown(line.from)} → {shown(line.to)} <span className="text-muted-foreground">(new default)</span></>;
    case "keepsOverride": return <>{k} yours, {shown(line.value)}, stays <span className="text-muted-foreground">(default {shown(line.default)})</span></>;
    case "invalid": return <>{k} yours, {shown(line.dropped)}, is dropped: {line.reason} <span className="text-muted-foreground">(default {shown(line.to)})</span></>;
    case "added": return <>{k} new, {shown(line.value)}</>;
    case "removed": return <>{k} removed{line.dropped !== null ? `, yours (${shown(line.dropped)}) is dropped` : ""}</>;
    default: return null;
  }
}

/**
 * Upgrade an installed recipe (R5): the newer version its source has, the three-way settings diff with a keep or
 * take for each setting both sides changed, what it adds or drops, and its evals.
 */
function UpgradeSheetEnabled({ recipe, onOpenChange, canEdit }: { recipe: { id: string; title: string } | null; onOpenChange: (open: boolean) => void; canEdit: boolean }) {
  const checkUpgrade = useAction(api.recipes.checkUpgrade);
  const upgrade = useAction(api.recipes.upgrade);
  const [check, setCheck] = useState<Upgrade | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [choices, setChoices] = useState<Record<string, "keep" | "take">>({});
  const [busy, setBusy] = useState(false);
  const id = recipe?.id ?? null;

  useEffect(() => {
    if (!id) return;
    let live = true;
    setCheck(null); setError(null); setChoices({});
    checkUpgrade({ recipeId: id }).then((c) => { if (live) setCheck(c); }, (e) => { if (live) setError(getErrorMessage(e)); });
    return () => { live = false; };
  }, [id, checkUpgrade]);

  const lines = check?.lines ?? [];
  const conflicts = lines.filter((l) => l.kind === "conflict");
  const others = lines.filter((l) => l.kind !== "conflict" && l.kind !== "unchanged");
  const unchanged = lines.length - conflicts.length - others.length;
  const label = (key: string) => check?.labels[key] ?? key;
  const ready = conflicts.every((l) => choices[l.key]);

  async function onUpgrade(c: Upgrade) {
    if (!c.to || !id) return;
    setBusy(true);
    try {
      await upgrade({ recipeId: id, ref: c.to.ref, sha: c.to.sha, bundleHash: c.to.bundleHash, choices, fromSha: c.from.sha, fromRevision: c.from.revision });
      toast.success(`Upgraded to v${c.to.version}`);
      onOpenChange(false);
    } catch (e) { toast.error(getErrorMessage(e)); } finally { setBusy(false); }
  }

  return (
    <Sheet open={recipe !== null} onOpenChange={onOpenChange}>
      <SheetContent className="w-full gap-0 overflow-y-auto sm:max-w-xl">
        <div className="border-b border-border p-4 pr-10">
          <SheetTitle className="text-base">Updates</SheetTitle>
          <SheetDescription className="text-xs">{recipe?.title}</SheetDescription>
        </div>
        <div className="flex-1 space-y-6 p-4 text-xs">
          {error && <p className="text-destructive">{error}</p>}
          {!check && !error && <p className="text-muted-foreground">Checking its source for a newer version…</p>}
          {check && !check.to && <p>v{check.from.version} is the newest. It stays pinned to {short(check.from.sha)} ({check.from.ref}).</p>}
          {check?.to && (
            <>
              <p className="text-sm">
                <span className="font-medium">v{check.from.version} → v{check.to.version}</span>
                <span className="font-mono text-[11px] text-muted-foreground"> · {check.to.ref} · {short(check.to.sha)}</span>
              </p>
              {conflicts.length > 0 && (
                <Section title={`You changed these, and so did the customization · ${conflicts.length}`}>
                  <ul className="divide-y divide-border border-y border-border">
                    {conflicts.map((l) => l.kind === "conflict" && (
                      <li key={l.key} className="space-y-2 py-2">
                        <p><span className="font-medium">{label(l.key)}.</span> Yours is {shown(l.override)}. The default was {shown(l.from)} and is now {shown(l.to)}.</p>
                        <div role="radiogroup" aria-label={label(l.key)} className="flex flex-wrap gap-1.5">
                          {(["keep", "take"] as const).map((c) => (
                            <button key={c} type="button" role="radio" aria-checked={choices[l.key] === c} className={cn(btn, choices[l.key] === c && "border-foreground bg-foreground text-background hover:bg-foreground/90")}
                              onClick={() => setChoices((x) => ({ ...x, [l.key]: c }))}>
                              {c === "keep" ? `Keep ${shown(l.override)}` : `Take ${shown(l.to)}`}
                            </button>
                          ))}
                        </div>
                      </li>
                    ))}
                  </ul>
                </Section>
              )}
              <Section title="Other settings">
                <ul className="space-y-0.5 font-mono text-[11px]">
                  {others.map((l) => <li key={l.key}><LineText line={l} label={label(l.key)} /></li>)}
                  <li className="text-muted-foreground">{unchanged} unchanged</li>
                </ul>
              </Section>
              {(check.permissions.added.length > 0 || check.permissions.removed.length > 0 || check.sections.added.length > 0 || check.sections.removed.length > 0) && (
                <Section title="What else changes">
                  <ul className="space-y-0.5">
                    {check.permissions.added.map((x) => <li key={`+${x}`}>Now {x}</li>)}
                    {check.permissions.removed.map((x) => <li key={`-${x}`}>No longer {x}</li>)}
                    {check.sections.added.map((x) => <li key={`+s${x}`}>Adds {sectionChange(x).label} to the {sectionChange(x).page} page</li>)}
                    {check.sections.removed.map((x) => <li key={`-s${x}`}>Drops {sectionChange(x).label} from the {sectionChange(x).page} page</li>)}
                  </ul>
                </Section>
              )}
              <Parts p={check} />
              <Section title={`Evals on v${check.to.version} · ${check.evals.filter((e) => e.ok).length} of ${check.evals.length} pass`}>
                <EvalResults evals={check.evals} />
                {conflicts.length > 0 && <p className="mt-1 text-muted-foreground">Run on your settings with every conflict kept.</p>}
              </Section>
            </>
          )}
        </div>
        {check?.to && (
          <div className="sticky bottom-0 flex items-center justify-between gap-2 border-t border-border bg-background p-3 text-xs">
            <span className="text-muted-foreground">{!canEdit ? "Admins and managers upgrade customizations." : ready ? "Your choices become a new settings revision." : "Choose keep or take for each conflict."}</span>
            <button type="button" className={primary} disabled={busy || !canEdit || !ready} onClick={() => void onUpgrade(check)}>Upgrade to v{check.to.version}</button>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

export function InstallSheet(props: React.ComponentProps<typeof InstallSheetEnabled>) {
  if (!props.open) return null;
  return <IntegrationGate feature="recipeRuntime" note><InstallSheetEnabled {...props} /></IntegrationGate>;
}

export function UpgradeSheet(props: React.ComponentProps<typeof UpgradeSheetEnabled>) {
  if (!props.recipe) return null;
  return <IntegrationGate feature="recipeRuntime" note><UpgradeSheetEnabled {...props} /></IntegrationGate>;
}
