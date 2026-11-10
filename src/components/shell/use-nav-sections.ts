"use client";

import { useMemo } from "react";
import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { useObjectLabels } from "../records/object-labels";
import { homeHref, visibleSections, withObjectLabels, withRecordObjects, type NavSection } from "./nav";

/**
 * The sidebar's and the palette's sections: the fixed pages less those workspace.nav hides from the viewer, each
 * object's list named as the workspace calls the object, and a
 * Records group of the org's own objects (CP7d), and an item for each module on in the workspace. `home` is where /dashboard opens; null until the nav has loaded.
 */
export function useNav(): { sections: readonly NavSection[]; home: string | null } {
  const available = useQuery(api.integrationsAvailable.status);
  const objects = useQuery(api.customObjects.list);
  const nav = useQuery(api.recipes.nav);
  const modules = useQuery(api.modules.list);
  const names = useObjectLabels();
  return useMemo(() => {
    const named = withObjectLabels(visibleSections(nav?.hidden ?? [], modules ?? []), (o) => names(o)?.pluralLabel);
    const sections = withRecordObjects(named, objects ?? []).map((section) => ({ ...section, items: section.items.filter((item) => {
      if (item.id === "linkedin") return available?.unipile === true;
      if (item.id === "agents") return available?.chatgpt === true;
      if (item.id === "ai-fields") return available?.chatgpt === true || available?.openrouter === true;
      if (item.href.startsWith("/dashboard/m/dialer") && !available?.dialer) return false;
      return true;
    }) }));
    return { sections, home: nav === undefined || modules === undefined || available === undefined ? null : homeHref(sections, nav?.home ?? "accounts") };
  }, [objects, nav, modules, names, available]);
}

export function useNavSections(): readonly NavSection[] {
  return useNav().sections;
}
