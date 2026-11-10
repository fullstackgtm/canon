import type { Doc } from "../../_generated/dataModel";
import type { ObjectValidator } from "../../../modules/kernel/schema.ts";
import { DEFAULT_BUDGET } from "./webhook";

export const AGENTS_MODULE = "@canon/agents";
export const DEFINITION_VIEW = "agentDefinition";
export const DEFINITION_CREATE = "createDefinition";
export const DEFINITION_UPDATE = "updateDefinition";
export const DEFINITION_FIELDS = ["label", "fieldSlugs", "budget", "route", "crmTrigger", "slack"] as const;
export type EventDefinition = Pick<Doc<"agents">, "label" | "route" | "crmTrigger" | "slack"> & {
  fieldSlugs: string[];
  budget: NonNullable<Doc<"agents">["budget"]>;
};

export const eventDefinitionSchema = {
  type: "object", value: {
    label: { fieldType: { type: "string" }, optional: false },
    fieldSlugs: { fieldType: { type: "array", value: { type: "string" } }, optional: false },
    budget: { fieldType: { type: "object", value: {
      turnsPerDay: { fieldType: { type: "number" }, optional: false },
      maxRounds: { fieldType: { type: "number" }, optional: false },
      maxTokens: { fieldType: { type: "number" }, optional: false },
      maxSeconds: { fieldType: { type: "number" }, optional: false },
    } }, optional: false },
    route: { fieldType: { type: "object", value: {
      audienceId: { fieldType: { type: "string" }, optional: false },
      rule: { fieldType: { type: "object", value: {
        fieldSlug: { fieldType: { type: "string" }, optional: false },
        op: { fieldType: { type: "union", value: [{ type: "literal", value: "equals" }, { type: "literal", value: "contains" }] }, optional: false },
        value: { fieldType: { type: "string" }, optional: false },
      } }, optional: true },
    } }, optional: true },
    crmTrigger: { fieldType: { type: "object", value: {
      event: { fieldType: { type: "literal", value: "deal.stage_changed" }, optional: false },
      toStage: { fieldType: { type: "string" }, optional: true },
    } }, optional: true },
    slack: { fieldType: { type: "object", value: {
      mode: { fieldType: { type: "union", value: ["all", "qualified", "failures"].map((value) => ({ type: "literal" as const, value })) }, optional: false },
    } }, optional: true },
  },
} satisfies ObjectValidator;

export function legacyDefinition(agent: Doc<"agents">): EventDefinition | null {
  if (agent.fieldSlugs === undefined) return null;
  return {
    label: agent.label, fieldSlugs: agent.fieldSlugs, budget: agent.budget ?? DEFAULT_BUDGET,
    ...(agent.route ? { route: agent.route } : {}),
    ...(agent.crmTrigger ? { crmTrigger: agent.crmTrigger } : {}),
    ...(agent.slack ? { slack: agent.slack } : {}),
  };
}
