/**
 * Recipe templates a workspace uses (docs/recipes.md, "Templates"). Enabling one on the Recipes page installs it
 * (convex/recipes.ts enableContribution). Canon's own default-on templates, its reports and dashboards, install here
 * the first time someone opens Dashboards; a cadence template is offered here until someone starts a cadence from it.
 */
import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { getCurrentUser, requireUser } from "./lib";
import { enabledFor } from "./lib/recipes";
import { installDefaults } from "./lib/templates";
import { templatePoint } from "../recipes/index.ts";
import { isTemplateKind, type Template } from "../recipes/templates.ts";

/** Install the default-on templates the workspace hasn't turned off or installed yet, as the caller. */
export const ensureDefaults = mutation({
  args: {},
  handler: async (ctx): Promise<{ created: number }> => ({ created: await installDefaults(ctx, await requireUser(ctx)) }),
});

/** The templates of one kind on in the workspace, with their specs, for a form that starts from one. */
export const offered = query({
  args: { kind: v.string() },
  handler: async (ctx, args) => {
    if (!isTemplateKind(args.kind)) throw new ConvexError(`${args.kind} is not a template kind`);
    const user = await getCurrentUser(ctx);
    if (!user) return [];
    return (await enabledFor(ctx, user.orgId, templatePoint(args.kind))).map(({ recipe, contribution }) => {
      const t = contribution.declares as Template;
      return { recipeId: recipe.id, recipeTitle: recipe.title, version: recipe.version, key: t.key, title: t.title, spec: t.spec };
    });
  },
});
