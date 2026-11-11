/**
 * What Ask Canon tells the model (the rule vocabulary and the workspace), and its stand-in on a local stack, where a
 * local check must never spend the dev user's real ChatGPT plan (lib/recipeAgentStandIn.ts decides when). The
 * stand-in answers as a model would, with a rule document and a summary, and Canon's check then reads it for real.
 * Free of database and Node-only imports.
 */
import { AUTOMATION_DOC } from "../../modules/kernel/automation.ts";

export const STAND_IN_MODEL = "local:stand-in";

/** The rule vocabulary, as the agent tool documents it. */
export const vocabulary = () => `A rule document: ${AUTOMATION_DOC}`;

export type Ws = {
  objects: ReadonlyArray<{ apiName: string; label: string; pluralLabel: string; fields: ReadonlyArray<{ apiName: string; label: string; type: string; options?: ReadonlyArray<{ value: string; label: string }> }> }>;
  members: ReadonlyArray<{ id: string; name: string }>;
  teams: ReadonlyArray<{ id: string; name: string }>;
  routingRules: ReadonlyArray<{ id: string; name: string }>;
  slackChannels: readonly string[];
  webhooks: ReadonlyArray<{ id: string; name: string }>;
  timezone: string;
};

/** The workspace as the model needs it: each object's fields (with their options' values), and the ids a rule may name. */
export function workspaceText(ws: Ws): string {
  const objects = ws.objects.map((o) => `- ${o.apiName} (${o.label}): ${o.fields.map((f) => `${f.apiName} ${f.type}${f.options?.length ? ` [${f.options.map((x) => x.value).join("|")}]` : ""}`).join(", ")}`);
  const ids = (label: string, xs: ReadonlyArray<{ id: string; name: string }>) => (xs.length ? `${label}: ${xs.map((x) => `${x.name} = ${x.id}`).join("; ")}` : `${label}: none`);
  return [
    "Objects and their fields (apiName type [option values]):", ...objects,
    ids("Members", ws.members), ids("Teams", ws.teams), ids("Routing rules", ws.routingRules), ids("Record webhooks", ws.webhooks),
    `Slack channels mapped: ${ws.slackChannels.join(", ") || "none"}`, `Time zone: ${ws.timezone}`,
  ].join("\n");
}

/**
 * A fixed answer: a rule on the object the request names first (its label or plural), else the first object; "changes" or "moves"
 * makes it a field change, else a new record (a change on companies and people, where Canon records no creation);
 * it creates a follow-up task for the record's owner.
 */
export function standInRule(ws: Ws, request: string): { rule: unknown; summary: string } {
  const text = request.toLowerCase();
  const at = (x: Ws["objects"][number]) => Math.min(...[x.label, x.pluralLabel].map((l) => text.indexOf(l.toLowerCase())).filter((i) => i >= 0), Infinity);
  const o = [...ws.objects].sort((x, y) => at(x) - at(y)).find((x) => at(x) < Infinity) ?? ws.objects[0];
  const party = o.apiName === "account" || o.apiName === "contact";
  const changes = party || /\bchang|\bmove/.test(text);
  return {
    rule: {
      name: `Follow up: ${request.slice(0, 60)}`, object: o.apiName, trigger: changes ? { kind: "updated" } : { kind: "created" }, conditions: [],
      actions: [{ kind: "create_task", subject: "Follow up on {record}", dueInDays: 2, owner: { kind: "record_owner" } }],
    },
    summary: `A follow-up task for the ${o.label.toLowerCase()}'s owner when one ${changes ? "changes" : "is created"}. (Local stand-in model: it always proposes a follow-up task.)`,
  };
}
