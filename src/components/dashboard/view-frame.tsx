"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { Plus } from "lucide-react";
import { useCommands } from "@/components/shell/command-palette";

export type ViewAction = {
  id: string;
  label: string;
  disabled?: boolean;
  icon?: ReactNode;
  primary?: boolean;
} & ({ onClick: () => void; href?: never } | { href: string; onClick?: never });

export function ViewFrame({ title, description, actions = [], secondaryActions, controls, filterReset, compact = false, children }: {
  title: string; description?: string; compact?: boolean; actions?: ViewAction[]; secondaryActions?: ReactNode; controls?: ReactNode;
  filterReset?: { onClick: () => void; disabled?: boolean }; children: ReactNode;
}) {
  const orderedActions = [...actions.filter((action) => !action.primary), ...actions.filter((action) => action.primary)];
  useCommands([
    ...orderedActions.map((action) => ({ id: action.id, label: action.label, disabled: action.disabled, group: title,
      ...(action.href !== undefined ? { href: action.href } : { run: action.onClick }),
    })),
    ...(filterReset ? [{ id: `${title}-clear-filters`, label: "Clear filters", run: filterReset.onClick, disabled: filterReset.disabled, group: title }] : []),
  ]);
  return <div className={compact ? "view-frame view-frame-compact" : "view-frame"}>
    <header className="view-frame-header">
      <div className="view-frame-title-row">
        <h1 className="view-frame-identity font-display text-2xl font-semibold">{title}</h1>
        {(orderedActions.length > 0 || secondaryActions) && <div className="view-frame-actions" role="group" aria-label={`${title} actions`}>
          {secondaryActions}
          {orderedActions.map((action) => {
            const className = action.primary ? "view-action view-action-primary" : "view-action";
            const content = <>{action.icon ?? (action.primary ? <Plus className="size-3.5" /> : null)}{action.label}</>;
            return action.href !== undefined && !action.disabled
              ? <Link key={action.id} href={action.href} className={className}>{content}</Link>
              : <button key={action.id} type="button" disabled={action.disabled} onClick={action.onClick} className={className}>{content}</button>;
          })}
        </div>}
      </div>
      <h2 className="sr-only">Page sections</h2>
      {description && <p className="view-frame-description max-w-[72ch] text-sm text-muted-foreground">{description}</p>}
    </header>
    {(controls || filterReset) && <div className="view-frame-controls">
      {controls && <div className="view-frame-filter-content">{controls}</div>}
      {filterReset && <button type="button" className="view-action view-frame-filter-reset" disabled={filterReset.disabled} onClick={filterReset.onClick}>Clear filters</button>}
    </div>}
    <div className="view-frame-content">{children}</div>
  </div>;
}

export function ReadFailure({ message, retry, retained = false }: { message: string; retry: () => void; retained?: boolean }) {
  return <div role="alert" className="mb-4 flex flex-wrap items-center justify-between gap-3 border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm">
    <span>{retained && "Showing the last loaded records. "}{message}</span>
    <button type="button" onClick={retry} className="view-action">Retry</button>
  </div>;
}

export function SelectionBar({ count, summary, onClear, children }: { count: number; summary?: ReactNode; onClear: () => void; children: ReactNode }) {
  return <div className="view-selection">
    {summary && <span className="text-muted-foreground">{summary}</span>}
    {count > 0 && <span>{count} selected</span>}
    {children}
    {count > 0 && <button type="button" onClick={onClear} className="ml-auto text-muted-foreground hover:text-foreground">Clear selection</button>}
  </div>;
}
