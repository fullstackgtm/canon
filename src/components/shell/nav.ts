import {
  Bot, Box, Briefcase, Building2, ChartColumn, CheckSquare, ClipboardList, Coins, Combine, Inbox, KeyRound, LayoutDashboard, Linkedin, MapPin, Network, Package, Phone, Plug, Radio, Receipt, Scale, Send, Settings, Sparkles, Target, TrendingUp, Users, type LucideIcon,
} from "lucide-react";
import { objectIcon } from "../records/object-icons.ts";
import { recordListOf } from "../records/record-target.ts";
import { NAV_PAGES, type NavPage } from "../../../recipes/models.ts";
import { NAV_SECTIONS as SECTION_ORDER, type NavIcon } from "../../../modules/kernel/manifest.ts";

export type NavItem = {
  /** How workspace.nav names it to hide it or open on it; Settings, Customization and Canon fields have none, so they always show. */
  id?: NavPage;
  label: string;
  href: string;
  icon: LucideIcon;
  /** A count shown beside the label. */
  badge?: "dueTasks";
  /** The object whose list this is: the item takes the object's plural name as the workspace calls it. */
  object?: string;
};

export type NavSection = {
  label: string;
  items: readonly NavItem[];
};

/** Where /dashboard lands when the workspace's page is hidden from the viewer and nothing else shows: the TAM explorer. */
export const HOME_HREF = "/dashboard/accounts";

/**
 * Canon's own pages in dashboard navigation: the sidebar, the phone drawer and
 * the command palette list these and each module on in the workspace (the
 * Work section, My work and Review, is the Work module's). Products,
 * Patch Plans, Plays, Notes and Duplicates are
 * off the nav (still routable).
 */
export const NAV_SECTIONS: readonly NavSection[] = [
  {
    label: "CRM",
    items: [
      { id: "accounts", label: "Accounts", href: "/dashboard/accounts", icon: Building2, object: "account" },
      { id: "people", label: "People", href: "/dashboard/contacts", icon: Users, object: "contact" },
      { id: "icps", label: "ICPs", href: "/dashboard/icps", icon: Target },
      { id: "audiences", label: "Audiences", href: "/dashboard/audiences", icon: Send },
    ],
  },
  {
    label: "Activity",
    items: [
      { id: "deals", label: "Opportunities", href: "/dashboard/deals", icon: TrendingUp, object: "deal" },
      { id: "reports", label: "Reports", href: "/dashboard/dashboards", icon: ChartColumn },
      { id: "linkedin", label: "LinkedIn", href: "/dashboard/linkedin", icon: Linkedin },
      { id: "runs", label: "Runs", href: "/dashboard/runs", icon: Radio },
      { id: "agents", label: "Agents", href: "/dashboard/agents", icon: Bot },
    ],
  },
  {
    label: "Admin",
    items: [
      { label: "Settings", href: "/dashboard/settings", icon: Settings },
      { label: "Customization", href: "/dashboard/customization", icon: Package },
      { id: "integrations", label: "Integrations", href: "/dashboard/integrations", icon: Plug },
      { label: "Canon fields", href: "/dashboard/canon-fields", icon: Combine },
      { label: "Account hierarchy", href: "/dashboard/account-hierarchy", icon: Network },
      { id: "ai-fields", label: "AI fields", href: "/dashboard/fields", icon: Sparkles },
      { id: "cli-pairing", label: "CLI Pairing", href: "/dashboard/cli-auth", icon: KeyRound },
    ],
  },
];

export const PALETTE_SECTIONS: readonly NavSection[] = NAV_SECTIONS;

/** Longest-prefix match so nested items don't double-highlight. */
export function isNavItemActive(pathname: string, href: string): boolean {
  if (href === "/dashboard") return pathname === "/dashboard";
  // A module's one entry opens its landing page, and stays active on every page of the module.
  const slug = /^\/dashboard\/m\/([^/?#]+)/.exec(href)?.[1];
  if (slug) return pathname === `/dashboard/m/${slug}` || pathname.startsWith(`/dashboard/m/${slug}/`);
  const object = /^\/dashboard\/records\/([^/]+)(?:\/|$)/.exec(pathname)?.[1];
  if (object && recordListOf(object, "").href === href) return true;
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** An org's own object, as the nav lists it (convex/customObjects.ts list). */
export type NavRecordObject = { apiName: string; pluralLabel: string; icon: string; archived: boolean };

/**
 * The sections with a Records group after Activity: one item per live custom
 * object (CP7d), each opening its generic list at /dashboard/records/<object>.
 * Archived objects are left out; with none, the sections are as they were.
 */
export function withRecordObjects(sections: readonly NavSection[], objects: readonly NavRecordObject[]): readonly NavSection[] {
  const items = objects.filter((o) => !o.archived).map((o) => ({ label: o.pluralLabel, href: `/dashboard/records/${o.apiName}`, icon: objectIcon(o.icon) }));
  if (!items.length) return sections;
  const at = sections.findIndex((s) => s.label === "Admin");
  const records: NavSection = { label: "Records", items };
  return at < 0 ? [...sections, records] : [...sections.slice(0, at), records, ...sections.slice(at)];
}

/** A place in the nav where a module shows Canon's own page (manifest NAV_SLOTS), with the id workspace.nav hides it by. */
export type NavLink = { id: string; label: string; href: string; icon: NavIcon; section: string; badge?: "dueTasks" };
/**
 * An installed module's nav entries (convex/modules.ts list): its own, when it has pages, and Canon pages it shows. An
 * own entry that takes a place in the nav has the place's `id` and the old URL that now opens it (`legacy`).
 */
export type NavModule = { moduleId?: string; reportsTakeover?: boolean; slug: string; nav: { label: string; icon: NavIcon; section: string; href: string; id?: string; legacy?: string } | null; links?: readonly NavLink[] };

const MODULE_ICONS: Record<NavIcon, LucideIcon> = {
  box: Box, clipboard: ClipboardList, coins: Coins, receipt: Receipt, scale: Scale, target: Target, briefcase: Briefcase, chart: ChartColumn, map: MapPin,
  check: CheckSquare, inbox: Inbox, send: Send, layout: LayoutDashboard, linkedin: Linkedin, phone: Phone, radio: Radio, bot: Bot, plug: Plug, sparkles: Sparkles, key: KeyRound,
};

const slotOrder = (id: string | undefined) => (id ? (NAV_PAGES as readonly string[]).indexOf(id) : -1);

/** The section's items with `item` in its place: before the first page that comes after it in NAV_PAGES, else last. */
function placed(items: readonly NavItem[], item: NavItem): NavItem[] {
  const at = slotOrder(item.id);
  const before = at < 0 ? -1 : items.findIndex((i) => slotOrder(i.id) > at);
  return before < 0 ? [...items, item] : [...items.slice(0, before), item, ...items.slice(before)];
}

/**
 * The sections with each module on in the workspace (docs/modules.md, "Places in the nav"): an entry that takes a
 * place, or shows Canon's page there, sits where that page sits; other entries go after them. A place Canon's own page
 * still holds stays Canon's, and the module's entry for it doesn't show. A place two modules take keeps the first, and
 * the second entry goes in as a module's own. A section only modules fill shows where the
 * sections' order puts it.
 */
export function withModules(sections: readonly NavSection[], modules: readonly NavModule[]): readonly NavSection[] {
  if (!modules.length) return sections;
  if (modules.some((m) => m.moduleId === "@canon/reports" && m.reportsTakeover && m.nav)) {
    sections = sections.map((s) => ({ ...s, items: s.items.filter((i) => i.id !== "reports") }));
  }
  // While Canon's own page still holds a place, it keeps it, and a module entry for that place waits for its retirement.
  const builtIn = new Set(sections.flatMap((s) => s.items.map((i) => i.id)).filter(Boolean));
  const entries = modules.flatMap((m) => [
    ...(m.links ?? []).map((l): NavItem & { section: string } => ({ id: l.id as NavPage, label: l.label, href: l.href, icon: MODULE_ICONS[l.icon] ?? Box, section: l.section, ...(l.badge ? { badge: l.badge } : {}) })),
    ...(m.nav ? [{ ...(m.nav.id ? { id: m.nav.id as NavPage } : {}), label: m.nav.label, href: m.nav.href, icon: MODULE_ICONS[m.nav.icon] ?? Box, section: m.nav.section }] : []),
  ]).filter((e) => !(e.id && builtIn.has(e.id)));
  const ordered = [...entries.filter((e) => e.id), ...entries.filter((e) => !e.id)];
  const added = (s: NavSection): NavSection => ({
    ...s,
    items: ordered.filter((e) => e.section === s.label).reduce<NavItem[]>((items, { section: _s, ...item }) => placed(items, item.id && items.some((i) => i.id === item.id) ? { ...item, id: undefined } : item), [...s.items]),
  });
  const all = SECTION_ORDER.map((label) => added(sections.find((s) => s.label === label) ?? { label, items: [] }));
  return [...all, ...sections.filter((s) => !(SECTION_ORDER as readonly string[]).includes(s.label))].filter((s) => s.items.length);
}

/** Where an old Canon URL, or one under it, now opens: the landing page of the module whose entry took its place, else null. */
export function movedTo(pathname: string, modules: readonly NavModule[]): string | null {
  const m = modules.find((x) => x.nav?.legacy && (x.nav.id !== "reports" || x.reportsTakeover === true) && (pathname === x.nav.legacy || pathname.startsWith(`${x.nav.legacy}/`)));
  return m?.nav ? m.nav.href : null;
}

/**
 * The built-in sections with the workspace's modules, less the pages workspace.nav hides. Modules join first, so a
 * section whose built-in pages are all hidden keeps its modules.
 */
export function visibleSections(hidden: readonly string[], modules: readonly NavModule[]): readonly NavSection[] {
  return withoutHidden(withModules(NAV_SECTIONS, modules), hidden);
}

/** The sections without the pages workspace.nav hides from the viewer; a section left empty goes too. */
export function withoutHidden(sections: readonly NavSection[], hidden: readonly string[]): readonly NavSection[] {
  if (!hidden.length) return sections;
  return sections.map((s) => ({ ...s, items: s.items.filter((i) => !i.id || !hidden.includes(i.id)) })).filter((s) => s.items.length);
}

/** The workspace's landing page if the viewer sees it, else the first page they do. */
export function homeHref(sections: readonly NavSection[], home: string): string {
  const items = sections.flatMap((s) => s.items);
  return (items.find((i) => i.id === home) ?? items.find((i) => i.id))?.href ?? HOME_HREF;
}

/** The sections with each object's list named as the workspace calls the object. */
export function withObjectLabels(sections: readonly NavSection[], plural: (object: string) => string | undefined): readonly NavSection[] {
  return sections.map((s) => ({ ...s, items: s.items.map((i) => (i.object && plural(i.object) ? { ...i, label: plural(i.object)! } : i)) }));
}

export function getActiveSectionLabel(pathname: string, sections: readonly NavSection[] = PALETTE_SECTIONS): string | undefined {
  return sections.find((section) =>
    section.items.some((item) => isNavItemActive(pathname, item.href)),
  )?.label;
}

export function reportsModuleTarget(modules: readonly (NavModule & { moduleId: string })[], path: "reports" | "dashboards", query: string): string | null {
  const reports = modules.find((m) => m.moduleId === "@canon/reports" && m.reportsTakeover && m.nav);
  if (!reports?.nav) return null;
  const params = new URLSearchParams(query);
  const view = params.get("view");
  if (view === "targets") return `/dashboard/settings/targets${query ? `?${query}` : ""}`;
  const page = view === "stages" ? "stages" : params.has("d") ? "dashboards" : params.has("report") || path === "reports" ? "builder" : null;
  const href = page ? `/dashboard/m/${reports.slug}/${page}` : reports.nav.href;
  return `${href}${query ? `?${query}` : ""}`;
}
