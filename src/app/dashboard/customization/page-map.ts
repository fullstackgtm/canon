/**
 * Which Canon page each contribution point changes (docs/customization.md), so the Customization page can list pages
 * and say what is applied to each. The theme and the navigation change every page, so they belong to the workspace.
 * Pure: the browser and tests import it.
 */
import { isCustomObjectName } from "../../../../modules/kernel/reportLanguage.ts";
import { isPointId, pointOf, type PointId } from "../../../../recipes/points.ts";
import { pageMarkdown } from "../../../../recipes/md/edit.ts";
import { lineDiff } from "../../../../recipes/workspace.ts";

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
  "workspace.pages": "workspace",
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

const RECORD_PAGES = {
  "account.page": { object: "account", title: "Account page", href: "/dashboard/accounts" },
  "contact.page": { object: "contact", title: "Contact page", href: "/dashboard/contacts" },
  "deal.page": { object: "deal", title: "Deal page", href: "/dashboard/deals" },
} as const;

export const standaloneHref = (slug: string) => `/dashboard/${isCustomObjectName(slug) ? "records" : "p"}/${encodeURIComponent(slug)}`;

type Version = {
  userId: string;
  name: string;
  isOwn: boolean;
  updatedAt: number;
  target: { point: string; key: string };
  pages: ReadonlyArray<{ slug: string; title: string }>;
  markdown: string;
  baseMarkdown: string;
};

function pagesForPerson<V extends Version>(versions: readonly V[]) {
  const recordRows = [];
  const standaloneRows = new Map<string, { version: V; object: string; title: string; href: string; standalone: true; primary: boolean }>();
  for (const version of versions) {
    const { point, key } = version.target;
    const record = RECORD_PAGES[point as keyof typeof RECORD_PAGES];
    if (record) recordRows.push({ version, ...record, standalone: false as const, primary: true });
    if (point === "workspace.pages" && !version.pages.some((p) => p.slug === key)) {
      standaloneRows.set(key, { version, object: key, title: key, href: standaloneHref(key), standalone: true, primary: true });
    }
    for (const { slug, title } of version.pages) {
      const primary = point === "workspace.pages" && key === slug;
      if (!standaloneRows.has(slug) || primary) {
        standaloneRows.set(slug, { version, object: slug, title, href: standaloneHref(slug), standalone: true, primary });
      }
    }
  }
  return [...recordRows, ...standaloneRows.values()].map((page) => {
    const before = pageMarkdown(page.version.baseMarkdown, page.object);
    const after = pageMarkdown(page.version.markdown, page.object);
    if (!before || !after) {
      const text = before || after;
      return { ...page, changedLines: text ? text.split("\n").length : 0 };
    }
    const { added, removed } = lineDiff(before, after);
    return { ...page, changedLines: added + removed };
  });
}

export function personalPageRows<V extends Version>(versions: readonly V[]) {
  const byPerson = new Map<string, V[]>();
  for (const version of versions) {
    const rows = byPerson.get(version.userId);
    if (rows) rows.push(version);
    else byPerson.set(version.userId, [version]);
  }
  const people = [...byPerson.values()].map((rows) => {
    const { userId, name, isOwn } = rows[0];
    return { userId, name, isOwn, updatedAt: Math.max(...rows.map((row) => row.updatedAt)), pages: pagesForPerson(rows) };
  });
  return { people, own: people.find((person) => person.isOwn)?.pages ?? [], review: people.filter((person) => !person.isOwn).flatMap((person) => person.pages) };
}
