/**
 * Which Canon page each contribution point changes (docs/customization.md), so the Customization page can list pages
 * and say what is applied to each. The theme and the navigation change every page, so they belong to the workspace.
 * Pure: the browser and tests import it.
 */
import { isPointId, pointOf, type PointId } from "../../../../recipes/points.ts";

export const CANON_PAGES = [
  { id: "deals", label: "Opportunities", href: "/dashboard/deals" },
  { id: "accounts", label: "Accounts", href: "/dashboard/accounts" },
  { id: "people", label: "People", href: "/dashboard/contacts" },
  { id: "icps", label: "ICPs", href: "/dashboard/icps" },
  { id: "reports", label: "Reports", href: "/dashboard/dashboards" },
  { id: "revenue", label: "Revenue", href: "/dashboard/revenue" },
  { id: "health", label: "Customer health", href: "/dashboard/health" },
  { id: "leads", label: "Leads", href: "/dashboard/leads" },
  { id: "abm", label: "Target accounts", href: "/dashboard/abm" },
  { id: "linkedin", label: "LinkedIn", href: "/dashboard/linkedin" },
  { id: "agents", label: "Agents", href: "/dashboard/agents" },
  { id: "automations", label: "Automations", href: "/dashboard/automations" },
  { id: "ai-fields", label: "AI fields", href: "/dashboard/fields" },
] as const;
export type CanonPageId = (typeof CANON_PAGES)[number]["id"] | "workspace";

/** Every point, placed on the page it changes. A new point fails to compile until it has a page. */
export const POINT_PAGE: Record<PointId, CanonPageId> = {
  "deal.page": "deals",
  "account.page": "accounts",
  "contact.page": "people",
  "workspace.theme": "workspace",
  "workspace.nav": "workspace",
  "forecast.model": "revenue",
  "health.model": "health",
  "scoring.lead": "leads",
  "signals.heat": "accounts",
  "hygiene.policy": "deals",
  "scoring.fit": "icps",
  "calls.model": "deals",
  "abm.model": "abm",
  fields: "ai-fields",
  "templates.reports": "reports",
  "templates.dashboards": "reports",
  "templates.automations": "automations",
  "templates.icps": "icps",
  "templates.pipelines": "deals",
  "templates.cadences": "linkedin",
};

/** The part of a point view (convex/recipes.ts, pointViews) the map reads. */
export type PointState = {
  id: string;
  title: string;
  cardinality: "exclusive" | "additive";
  contributions: ReadonlyArray<{ recipeId: string; recipeTitle: string; title: string; enabled: boolean }>;
};

/** What a point has applied, or null when it runs as a new workspace starts. */
export type Applied = { point: string; title: string; by: string };

export function appliedAt(point: PointState): Applied | null {
  if (!isPointId(point.id)) return null;
  const def = pointOf(point.id);
  const on = point.contributions.filter((c) => c.enabled);
  if (def.cardinality === "exclusive") {
    const inForce = on[0];
    return inForce && inForce.recipeId !== def.defaults.newWorkspace ? { point: point.id, title: point.title, by: inForce.recipeTitle } : null;
  }
  const defaults: readonly string[] = def.defaultOn ?? [];
  const changed = on.some((c) => !defaults.includes(c.recipeId)) || point.contributions.some((c) => !c.enabled && defaults.includes(c.recipeId));
  return changed ? { point: point.id, title: point.title, by: `${on.length} of ${point.contributions.length} on` } : null;
}

export type PageRow = { id: CanonPageId; label: string; href: string; points: PointState[]; applied: Applied[]; offered: number };

/** Each Canon page with its points, what is applied there and how many contributions it could still turn on. */
export function pageRows(points: readonly PointState[]): { pages: PageRow[]; workspace: PageRow } {
  const row = (id: CanonPageId, label: string, href: string): PageRow => {
    const here = points.filter((p) => POINT_PAGE[p.id as PointId] === id);
    return {
      id, label, href, points: here,
      applied: here.flatMap((p) => appliedAt(p) ?? []),
      offered: here.reduce((n, p) => n + p.contributions.filter((c) => !c.enabled).length, 0),
    };
  };
  return { pages: CANON_PAGES.map((p) => row(p.id, p.label, p.href)), workspace: row("workspace", "Every page", "/dashboard") };
}
