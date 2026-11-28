import type { CallDecl, ModuleManifest } from "./manifest.ts";
import { coreOf } from "./schema.ts";

/** Canon owns these operations and their validation, independently of a module's call declaration. */
export const CANON_OPERATIONS = [
  "population.start", "forms.publish", "submissions.resolve",
  "runs.stopJob",
  "research.start", "research.probe", "research.stop", "research.autoAccept", "research.refresh",
  "agents.create", "agents.archive", "agents.setRouting", "agents.setCrmTrigger", "agents.setSlack",
  "agents.testRun", "agents.setOwner", "agents.setPaused", "agents.rotateSecret", "grants.create", "grants.revoke",
] as const;

export type CanonOperation = typeof CANON_OPERATIONS[number];

export const isCanonOperation = (name: string): name is CanonOperation =>
  CANON_OPERATIONS.some((operation) => operation === name);


/** The first atomic Canon binding supports only a free population's direct job id. */
export function canonCallProblems(m: ModuleManifest, name: string, call: CallDecl): string[] {
  if (call.canon?.operation === "submissions.resolve") return m.id !== "@canon/inbound" || call.canon.then ? ["submissions.resolve requires Inbound and no then binding"] : [];
  const then = call.canon?.then;
  if (!then) return call.canon?.operation === "forms.publish" ? ["forms.publish requires an atomic form binding"] : [];
  const at = `calls.${name}.canon.then`, errors: string[] = [];
  const machine = m.machines?.[then.machine], t = machine?.transitions[then.transition];
  const form = call.canon!.operation === "forms.publish";
  if (!form && call.canon!.operation !== "population.start") errors.push(`${at} supports only population.start`);
  if (!call.capability || !t || t.system || t.capability !== call.capability || t.agent !== "human" || t.effects?.length || t.evidence?.length || t.ai || t.run || t.at || t.seal || t.dirties?.length) errors.push(`${at} requires a plain human member transition with the same capability`);
  if (!machine || call.writes.length !== 1 || call.writes[0] !== machine.collection) errors.push(`${at} writes exactly its machine collection`);
  const args = call.args?.value ?? {};
  if (then.key === then.expect || Object.keys(args).length !== 2 || args[then.key]?.optional !== false || args[then.expect]?.optional !== false || coreOf(args[then.key]?.fieldType ?? { type: "null" }).type !== "string" || coreOf(args[then.expect]?.fieldType ?? { type: "null" }).type !== "number") errors.push(`${at} takes only a required text key and numeric expected version`);
  const transitionArgs = t?.args?.value ?? {};
  if (form) {
    if (m.id !== "@canon/inbound" || machine?.collection !== "forms") errors.push(`${at} requires the Inbound forms collection`);
    if (Object.keys(transitionArgs).join() !== "publicId" || transitionArgs.publicId.optional || coreOf(transitionArgs.publicId.fieldType).type !== "string" || JSON.stringify(then.args) !== JSON.stringify({ publicId: { result: "publicId" } }) || Object.keys(then.input).length) errors.push(`${at} binds only the publicId with no document inputs`);
    return errors;
  }
  if (Object.keys(transitionArgs).join() !== "jobId" || transitionArgs.jobId.optional || coreOf(transitionArgs.jobId.fieldType).type !== "string" || Object.keys(then.args).join() !== "jobId" || (then.args as { jobId: { result: string } }).jobId.result !== "jobId") errors.push(`${at} binds only the direct population jobId result`);
  const input = Object.keys(then.input);
  if (!input.includes("query") || !input.includes("title") || input.some((k) => !["query", "title", "detail"].includes(k))) errors.push(`${at}.input names query, title and optional detail`);
  const collection = machine && m.collections[machine.collection];
  for (const { field } of Object.values(then.input)) if (coreOf(collection?.schema.value[field]?.fieldType ?? { type: "null" }).type !== "string") errors.push(`${at}.input reads declared text data fields only`);
  return errors;
}
