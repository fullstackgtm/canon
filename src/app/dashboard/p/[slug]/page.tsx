"use client";
import { useCustomizeMode } from "@/components/customize/customize-mode";
import { parseRecipe } from "../../../../../recipes/md/parse";
import { use, useMemo } from "react";
import { useQuery } from "convex/react";
import { api } from "../../../../../convex/_generated/api";
import { PageSections } from "@/components/records/page-sections";
import { dataRenderers } from "@/components/records/data-section";
import { useShapeMode } from "@/components/records/shape/shape-mode";

export default function WorkspacePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = use(params);
  const stored = useQuery(api.recipes.workspacePage, { slug });
  const workflow = useCustomizeMode()?.workflow?.targets.find((t) => t.target === slug);
  const parsed = useMemo(() => workflow ? parseRecipe(workflow.markdown).recipe : null, [workflow]);
  const preview = parsed && parsed.workspacePages?.find((p) => p.slug === slug);
  const spec = preview && workflow ? { ...preview, recipeId: workflow.recipeId, recipeTitle: parsed!.meta.title, layoutTree: parsed!.layouts?.[slug], canEdit: true } : stored;
  const markdown = useQuery(api.workspaceRecipes.markdown, spec?.canEdit ? { recipeId: spec.recipeId } : "skip");
  const shape = useShapeMode({ object: slug, base: spec?.sections ?? [], layoutTree: spec?.layoutTree, markdown: workflow?.markdown ?? markdown?.markdown ?? null, recipeId: spec?.canEdit ? spec.recipeId : null, revision: markdown?.revision ?? null, recipeTitle: spec?.recipeTitle });
  if (spec === undefined) return <p role="status" className="p-6 text-sm text-muted-foreground">Loading page…</p>;
  if (!spec) return <div className="p-6"><h1 className="text-xl font-semibold">Page not found</h1><p className="text-sm text-muted-foreground">This page is unavailable or has been turned off.</p></div>;
  return <div className="min-w-0 max-w-full space-y-6 p-4 md:p-6"><h1 className="break-words text-2xl font-semibold">{spec.title}</h1>{shape.provider(<PageSections object="workspace" page={shape.page} stage={null} renderers={dataRenderers({ id: "", values: {} }, [], "workspace")} /> )}</div>;
}
