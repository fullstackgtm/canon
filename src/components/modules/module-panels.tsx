"use client";

import { Component, type ReactNode } from "react";
import Link from "next/link";
import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { ModulePage } from "./module-page";

type PanelPage = "deal" | "company" | "person";

class PanelBoundary extends Component<{ children: ReactNode; fallback?: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (!this.state.failed) return this.props.children;
    if (this.props.fallback !== undefined) return this.props.fallback;
    return (
      <p className="text-sm text-muted-foreground">
        Couldn&apos;t load. <button type="button" className="underline" onClick={() => this.setState({ failed: false })}>Try again</button>
      </p>
    );
  }
}

type Props = {
  page: PanelPage; record: string; enabled?: boolean; revision?: string;
  renderSections?: (replaced: ReadonlySet<string>) => ReactNode;
  fallback?: (kind: string) => ReactNode;
};

/**
 * The panels enabled modules add to Canon's record page (docs/modules.md, "On Canon's pages"), read as the person who
 * opens it. Which panels, and the record as each module names it, come from `api.modules.contributions`; each panel is
 * the module's own page, served at its panel path, drawn in place.
 */
export function ModulePanels(props: Props) {
  return <PanelBoundary fallback={props.renderSections?.(new Set<string>())}><ContributedPanels {...props} /></PanelBoundary>;
}

function ContributedPanels({ page, record, enabled = true, revision, renderSections, fallback }: Props) {
  const modules = useQuery(api.modules.contributions, enabled ? { page, record } : "skip");
  const replaced = new Set<string>();
  const panels = (modules ?? []).flatMap((m) => (m.panels ?? []).map((p) => ({ ...p, module: m.module, moduleTitle: m.title, record: m.record ?? record }))).filter((p) => {
    if (!p.replaces || !renderSections) return true;
    if (replaced.has(p.replaces)) return false;
    replaced.add(p.replaces);
    return true;
  });
  return (
    <>
      {renderSections?.(replaced)}
      {panels.length > 0 && <div className={`${renderSections ? "mt-6 " : ""}grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-2`} aria-label="From modules">
        {panels.map((p) => {
          const recipe = p.replaces ? fallback?.(p.replaces) : undefined;
          const frame = (body: ReactNode) => (
            <section className="rounded-lg border border-border bg-card p-4">
              <header className="mb-3 flex items-baseline justify-between gap-2">
                <h2 className="text-sm font-semibold">{p.title}</h2>
                <span className="text-xs text-muted-foreground">
                  From {p.moduleTitle}
                  {p.link && (
                    <> · <Link className="underline-offset-2 hover:underline" href={`/dashboard/m/${p.module}/${p.link.path.replaceAll("{$query.record}", encodeURIComponent(p.record))}`}>{p.link.label}</Link></>
                  )}
                </span>
              </header>
              {body}
            </section>
          );
          return (
            <PanelBoundary key={`${p.module}:${p.id}:${p.record}:${revision ?? ""}`} fallback={recipe}>
              <ModulePage module={p.module} path={p.path.split("/")} query={{ record: p.record }} embedded fallback={recipe} frame={frame} />
            </PanelBoundary>
          );
        })}
      </div>}
    </>
  );
}
