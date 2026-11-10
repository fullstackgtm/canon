import type { Id } from "../../_generated/dataModel";
import type { QueryCtx } from "../../_generated/server";
import { canonicalJson } from "../../../modules/kernel/integrity.ts";
import { personScope } from "../modules/scope";
import { installedModule, isEnabled, manifestOf } from "../modules/packages";
import { roleIn } from "../../permissions";

import { renderVariables, variableFields } from "../sequences/variables";

export type Sq1MergeField = "to.name" | "to.firstName" | "to.email" | "company.name" | "company.domain" | "sender.name" | "sender.address";
const supported = new Set(["to.name", "to.firstName", "to.email", "company.name", "company.domain", "sender.name", "sender.address"]);
export function sq1MergeFields(template: { subject: string; body: string }): Sq1MergeField[] | null {
  if (!template.subject.trim() || template.subject.length > 200 || /[\r\n]/.test(template.subject) || !template.body.trim() || template.body.length > 5000) return null;
  if (/\|\s*default/.test(template.subject + template.body)) return null;
  const fields = variableFields(template);
  if (fields.some((f) => !supported.has(f))) return null;
  const probe = renderVariables(template, Object.fromEntries(fields.map((f) => [f, "Sample"])), "valid", false);
  return probe.problems.length ? null : fields as Sq1MergeField[];
}
export function fillSq1Template(value: string, values: Partial<Record<Sq1MergeField, string>>, max: number): string | null {
  const rendered = renderVariables({ subject: value, body: "" }, values, "valid", false);
  return rendered.problems.length || rendered.subject.length > max ? null : rendered.subject;
}
export const sq1CanonicalHash = async (value: unknown) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson(value)))), (b) => b.toString(16).padStart(2, "0")).join("");

export async function readSq1TemplateSet(ctx: QueryCtx, orgId: Id<"organizations">, launchId: Id<"sequenceLaunches">, principals: readonly Id<"users">[]) {
  const launch = await ctx.db.get(launchId);
  if (!launch || launch.orgId !== orgId || launch.moduleId !== "@canon/sequences" || launch.state !== "active" || launch.templateSetVersion !== 1 || !principals.length
    || !Number.isSafeInteger(launch.authorizationEpoch) || launch.authorizationEpoch < 1) return null;
  const pkg = await installedModule(ctx, orgId, launch.moduleId);
  const email = pkg ? manifestOf(pkg).outbound?.email : null;
  if (!pkg || pkg.pending || launch.packageEpoch !== (pkg.epoch ?? 1) || !(await isEnabled(ctx, orgId, launch.moduleId))
    || !email?.from.includes("member_mailbox") || !email.kinds.includes("automated") || !launch.allowedChannels.includes("email")
    || !launch.approvedSenderRefs.length || launch.approvedSenderRefs.length > 20 || new Set(launch.approvedSenderRefs).size !== launch.approvedSenderRefs.length) return null;
  for (const id of new Set(principals)) {
    const user = await ctx.db.get(id);
    if (!user || !user.isActive || user.isHidden || await roleIn(ctx, user, orgId) === null) return null;
    const scope = await personScope(ctx, orgId, id, launch.moduleId);
    if (!scope || !(await scope.peek(launch.projection.collection, launch.projection.key))) return null;
  }
  const templates = [], preview = [], keys = new Set<string>();
  if (!launch.approvedPlan.steps.length || launch.approvedPlan.steps.length > 100) return null;
  for (const [ordinal, step] of launch.approvedPlan.steps.entries()) {
    if (step.ordinal !== ordinal || step.occurrence !== 0 || !step.key || keys.has(step.key) || step.variants.length > 20) return null;
    keys.add(step.key);
    if (step.kind !== "auto_email" && step.variants.length) return null;
    const variants = new Set<string>();
    for (const variant of step.variants) {
      if (!variant.key || variants.has(variant.key) || !Number.isInteger(variant.weight) || variant.weight < 1 || variant.weight > 100 || !sq1MergeFields(variant)
        || await sq1CanonicalHash(["canon.sq1.template.v1", "email", variant.subject, variant.body]) !== variant.templateHash) return null;
      variants.add(variant.key);
      templates.push({ step: { key: step.key, ordinal }, variant: variant.key, channel: "email" as const, templateHash: variant.templateHash });
      preview.push({ stepKey: step.key, ordinal, variant: variant.key, subject: variant.subject, body: variant.body });
    }
    if (step.kind === "auto_email" && (!step.variants.length || step.variants.reduce((n, v) => n + v.weight, 0) !== 100)) return null;
  }
  templates.sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b), "en"));
  if (!templates.length || canonicalJson(templates) !== canonicalJson(launch.approvedTemplates) || await sq1CanonicalHash(["canon.sq1.template-set.v1", templates]) !== launch.templateSetHash) return null;
  return { launch, templates, preview };
}
