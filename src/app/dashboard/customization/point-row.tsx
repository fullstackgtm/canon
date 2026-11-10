"use client";

import Link from "next/link";
import type { FunctionReturnType } from "convex/server";
import { ChevronRight, SlidersHorizontal } from "lucide-react";
import { api } from "../../../../convex/_generated/api";
import { isFirstParty } from "../../../../recipes";
import { SelectField } from "@/components/ui/select";
import { cn } from "@/lib/utils";

type PointView = NonNullable<FunctionReturnType<typeof api.recipes.forOrg>>["points"][number];

const btn = "inline-flex items-center gap-1 border border-border px-2 py-1 text-xs font-medium hover:bg-muted disabled:opacity-50";
const tag = "inline-flex items-center border border-border px-1.5 py-0.5 text-xs font-medium text-muted-foreground";

const CARDINALITY: Record<PointView["cardinality"], string> = { exclusive: "One at a time", additive: "Any number" };
const contributionId = (c: { recipeId: string; key: string }) => `${c.recipeId}\u0000${c.key}`;

export type Offered = PointView["contributions"][number];

/** One contribution point: a picker when only one can be on, a switch per contribution when any number can. */
export function PointRow({ point, canEdit, busy, open = false, onSettings, onEnable, onDisable }: {
  point: PointView; canEdit: boolean; busy: boolean; open?: boolean; onSettings?: (c: Offered) => void; onEnable: (c: Offered) => Promise<void>; onDisable: (c: Offered) => Promise<void>;
}) {
  const on = point.contributions.find((c) => c.enabled);
  return (
    <details className="group" open={open}>
      <summary className="grid cursor-pointer list-none grid-cols-[minmax(0,1fr)_auto] items-center gap-4 px-4 py-3 hover:bg-muted/50 [&::-webkit-details-marker]:hidden">
        <span className="min-w-0">
          <span className="block text-sm font-medium">{point.title}</span>
          <span className="block text-xs text-muted-foreground">{point.description}</span>
        </span>
        <span className="flex items-center gap-3 text-xs text-muted-foreground">
          <span className="max-w-40 truncate sm:max-w-64">
            {point.cardinality === "exclusive" ? on?.recipeTitle ?? "Canon's default" : `${point.contributions.filter((c) => c.enabled).length} of ${point.contributions.length} on`}
          </span>
          <ChevronRight className="h-4 w-4 shrink-0 transition-transform group-open:rotate-90" />
        </span>
      </summary>
      <div className="border-t border-border px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className={tag}>{CARDINALITY[point.cardinality]}</span>
        <span className={cn(tag, "normal-case tracking-normal")}>{point.id}</span>
      </div>
      {point.cardinality === "exclusive" ? (
        <div className="mt-4 space-y-3">
          <SelectField aria-label={point.title} className="w-full sm:w-80" size="default" disabled={!canEdit || busy}
            value={on ? contributionId(on) : ""} placeholder="Canon's default"
            onValueChange={(v) => { const c = point.contributions.find((x) => contributionId(x) === v); if (c && !c.enabled) void onEnable(c); }}
            options={point.contributions.map((c) => ({ value: contributionId(c), label: isFirstParty(c.recipeId) ? c.recipeTitle : `${c.recipeTitle} (${c.recipeId})` }))} />
          {on && onSettings && point.kind === "model" && (
            <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              Its numbers are settings of {on.recipeTitle}.
              <button type="button" className={btn} onClick={() => onSettings(on)}><SlidersHorizontal className="h-3.5 w-3.5" />Settings</button>
            </p>
          )}
          {on && onSettings && point.kind === "theme" && (
            <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              Colours, heading type and corners for everyone in the workspace.
              <button type="button" className={btn} onClick={() => onSettings(on)}><SlidersHorizontal className="h-3.5 w-3.5" />Settings</button>
            </p>
          )}
          {on && point.id === "deal.page" && (
            <p className="text-xs text-muted-foreground">
              {on.hasPlays ? "Runs a play on every deal: the keeper, research and drafts follow this customization." : "Shows each deal's fields in sections, with no play."}
            </p>
          )}
        </div>
      ) : (
        <ul className="mt-4 divide-y divide-border border-y border-border">
          {point.contributions.map((c) => (
            <li key={contributionId(c)} className="flex items-center justify-between gap-3 py-2 text-sm">
              <span className="min-w-0">
                {c.title} <span className="text-muted-foreground">· {c.recipeTitle}</span>
                {c.install && <InstallLine install={c.install} offered={c.version} />}
              </span>
              <span className="flex shrink-0 gap-2">
                {c.install?.state === "none" && (
                  <button type="button" className={btn} disabled={!canEdit || busy} aria-label={`Install ${c.title} from ${c.recipeTitle}`} onClick={() => void onEnable(c)}>Install</button>
                )}
                {/* A default-on template is on before it is installed, so it can be turned off before anything installs it. */}
                {(c.install?.state !== "none" || c.enabled) && (
                  <button type="button" role="switch" aria-checked={c.enabled} aria-label={`${c.title} from ${c.recipeTitle}`} disabled={!canEdit || busy}
                    className={cn(btn, c.enabled && "border-foreground bg-foreground text-background hover:bg-foreground/90")}
                    onClick={() => void (c.enabled ? onDisable(c) : onEnable(c))}>{c.enabled ? "On" : "Off"}</button>
                )}
              </span>
            </li>
          ))}
          {!point.contributions.length && <li className="py-2 text-sm text-muted-foreground">Nothing installed offers anything here yet.</li>}
        </ul>
      )}
      </div>
    </details>
  );
}

/** Where a template's install stands, with the version it came from when that isn't the version the recipe offers now. */
function InstallLine({ install, offered }: { install: NonNullable<Offered["install"]>; offered: string }) {
  if (install.state === "none") return null;
  // A field someone made under the recipe's slug, before the recipe, has no version it came from.
  const from = !install.version ? "made in this workspace" : install.version === offered ? `v${install.version}` : `v${install.version}; the customization now offers v${offered}, which changes only new installs`;
  return (
    <span className="block text-xs text-muted-foreground">
      {install.state === "installed" && (install.by
        ? <>Already provided by {install.by}, as <Link className="underline underline-offset-2 hover:text-foreground" href={install.row.href}>{install.row.name}</Link></>
        : <>Installed as <Link className="underline underline-offset-2 hover:text-foreground" href={install.row.href}>{install.row.name}</Link> · {from}</>)}
      {install.state === "offered" && <>Offered when someone starts a LinkedIn cadence · {from}</>}
      {install.state === "deleted" && <>Installed, then deleted here; it won&apos;t be installed again{install.version ? ` · ${from}` : ""}</>}
    </span>
  );
}

