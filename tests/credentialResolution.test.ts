/**
 * Census: every credential Canon accepts resolves to a member through one gate, lib/membership.ts credentialMember,
 * which refuses a member who isn't active in the workspace the credential acts in. It lists every table holding a
 * credential, every lookup of one by its secret, every lookup of a member by sign-in id and every read of the
 * signed-in identity, and fails on one it doesn't judge, so the next credential type can't skip the gate.
 * tests/deactivatedMemberAccess.test.ts proves the gate's behavior through each path.
 */
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";

const ROOT = join(import.meta.dirname, "..");
const read = (file: string) => readFileSync(join(ROOT, file), "utf8");

/** The gates: each turns a credential into a member, and each must ask credentialMember. */
const GATES = [
  "convex/lib.ts#scopeUserToActiveOrg", // a session's identity: Clerk, /mcp and the canon CLI's service JWT, a self-hosted JWT
  "convex/cliAuth.ts#getTokenByHash", // a paired CLI token, on every path that takes one
  "convex/agentIdentityData.ts#clerkIdentity", // a paired CLI token turned into a service JWT for /mcp and /api/v1
  "convex/localAuth.ts#session", // a self-hosted session cookie
  "convex/localAuth.ts#signIn", // a self-hosted password
  "convex/workspaceTransfer.ts#memberIn", // an export key's admin
  "convex/workspaceImport.ts#importCaller", // an import key's admin
  "convex/emailLog.ts#loggingMember", // a logging address
] as const;

/** Calls that reach a member only through a gate. A declaration making one is judged checked. */
const THROUGH_A_GATE = ["credentialMember(", "scopeUserToActiveOrg(", "getTokenByHash", "getCurrentUser(", "requireUser(", "requireCap(", "getUserByClerkId", "memberIn(", "loggingMember(", "exportCaller(", "importCaller("];

/** Each table holding a credential: the gate that resolves it, or why it names no member who could act. */
const CREDENTIAL_TABLES: Record<string, string> = {
  cliTokens: "convex/cliAuth.ts#getTokenByHash",
  localSessions: "convex/localAuth.ts#session",
  localCredentials: "convex/localAuth.ts#signIn",
  workspaceExportKeys: "convex/workspaceTransfer.ts#memberIn",
  workspaceImportKeys: "convex/workspaceImport.ts#importCaller",
  emailLogAddresses: "convex/emailLog.ts#loggingMember",
  localInvites: "not a member yet: it takes over a record nobody signs in as, once, and only while that record is on (localAuth.register)",
  cliAuthRequests: "a pending pairing: it becomes a token only when a signed-in member approves it (cliAuth.approve)",
  agentRegistrations: "a self-registered agent reads only public endpoints and belongs to no workspace; claiming one grants nothing (agentAuth.ts)",
  researchSessions: "a public research link; saving one into a workspace takes a signed-in member (researchSessions.ts)",
  moduleShareGrants: "an outside visitor's link to one module share: it acts as no member, and lapses when its issuer stops being an admin (lib/modules/grants.ts)",
  moduleVisitors: "an outside visitor's session on a module share (lib/modules/visitors.ts)",
  moduleVisitCodes: "an outside visitor's email code on a module share (lib/modules/visitors.ts)",
  moduleFiles: "a file an outside visitor uploaded to a module share",
  githubRecipeSetupStates: "a one-time state bound to the signed-in member who started the GitHub setup (githubRecipes.ts ownState)",
  agentWebhooks: "signs what an agent's webhook receives; it names no member",
  recordWebhookEndpoints: "signs what Canon sends out; delivery stops when its creator stops being an admin (recordWebhooks.ts roleIn)",
  outboundTargets: "signs what a workspace's module sends go out to; names no member",
  connectorLinks: "a connector webhook's signing secret; a member's link feeds only while they are active (lib/connectors/grants.ts)",
  oauthStates: "a one-time state of the signed-in member who started a CRM connection (hubspotActions, salesforceActions)",
  signalBoards: "a public job board's id, not a credential",
};

/** Lookups that are not a credential reaching a member: Clerk's sync, the demo sign-in, outside visitors, operators. */
const NOT_A_CREDENTIAL: Record<string, string> = {
  "convex/lib.ts#devBypassUser": "the local stack's demo sign-in (FSGTM_ENABLE_DEMO_DATA), off on every deployment",
  "convex/lib.ts#agentClientOf": "names the agent client of a call already signed in",
  "convex/localAuth.ts#requireBroker": "the self-hosted sign-in server itself, not a member",
  "convex/localAuth.ts#register": "a new login: the first admin, or an invitation that takes over its record",
  "convex/localAuth.ts#signOut": "deletes a session",
  "convex/users.ts#upsertFromClerk": "Clerk's membership events",
  "convex/users.ts#patchFromClerk": "Clerk's profile events",
  "convex/users.ts#deactivateFromClerk": "Clerk's account deletion",
  "convex/users.ts#removeMembershipFromClerk": "Clerk's membership removal",
  "convex/cliAuth.ts#poll": "a pending pairing's status, by its device code",
  "convex/cliAuth.ts#claim": "turns an approved pairing into a token, which getTokenByHash then gates",
  "convex/agentAuth.ts#validate": "a public agent registration: public endpoints only, no workspace",
  "convex/githubRecipes.ts#ownState": "a one-time state of the signed-in member (requireDecider signs them in)",
  "convex/gtm.ts#doAction": "a dry run reads nothing; an apply runs a handler that signs the caller in (getCurrentUser)",
  "convex/modules.ts#transition": "names who signed a module's evidence; the transition signs the caller in",
  "convex/lib/modules/visitors.ts#visitorScope": "an outside visitor's link and session on a module share: no member",
  "convex/operatorDashboards.ts#get": "Canon's operator dashboard, gated by an operator link",
  "convex/operatorTools.ts#clerkIdentity": "Canon's operator tools, gated by an operator allowlist, not a workspace",
  "convex/operatorTools.ts#createState": "Canon's operator sign-in state",
  "convex/operatorTools.ts#consumeState": "Canon's operator sign-in state",
  "convex/operatorToolsActions.ts#startGithubLink": "Canon's operator tools",
  "convex/operatorToolsActions.ts#completeGithubLink": "Canon's operator tools",
  "convex/operatorToolsActions.ts#issueBugDropToken": "Canon's operator tools",
  "convex/researchSessions.ts#get": "a public research link",
  "convex/researchSessions.ts#claimAccess": "matches a verified email to a waitlist invitation; saving it signs the member in (claim)",
  "convex/researchSessions.ts#claimForUser": "a public research link, saved for a member claim already signed in",
  "convex/researchSessions.ts#updateOnboarding": "a public research link",
  "convex/researchSessions.ts#joinWaitlist": "a public research link",
};

function files(dir: string): string[] {
  return readdirSync(join(ROOT, dir)).flatMap((name) => {
    const path = join(dir, name);
    if (name === "_generated" || name === "node_modules") return [];
    return statSync(join(ROOT, path)).isDirectory() ? files(path) : path.endsWith(".ts") ? [path] : [];
  });
}

/** The top-level declaration around `index` in `text`, by name, and its text. */
function declarationAt(text: string, index: number): { name: string; body: string } {
  const decl = /^(?:export\s+)?(?:const|let|async\s+function\*?|function\*?)\s+(\w+)/gm;
  let name = "(module)", start = 0;
  for (const m of text.matchAll(decl)) {
    if (m.index! > index) break;
    name = m[1]!; start = m.index!;
  }
  decl.lastIndex = index;
  const next = [...text.slice(index).matchAll(decl)][0];
  return { name, body: text.slice(start, next ? index + next.index! : text.length) };
}

const LOOKUPS = [
  /ctx\.auth\.getUserIdentity\(\)/g,
  /withIndex\("by_clerkUserId"/g,
  /withIndex\("by_(?:tokenHash|keyHash|sessionHash|claimTokenHash|deviceCodeHash|stateHash|codeHash|token)"/g,
];
const SOURCES = files("convex").filter((f) => !/^convex\/(?:dev[A-Z]\w*|devSeed)\.ts$/.test(f) && f !== "convex/schema.ts");

test("every gate asks credentialMember", () => {
  for (const gate of GATES) {
    const [file, name] = gate.split("#") as [string, string];
    const text = read(file);
    const at = text.search(new RegExp(`^(?:export\\s+)?(?:const|async function|function)\\s+${name}\\b`, "m"));
    assert.ok(at >= 0, `${gate} is gone: update the census`);
    assert.match(declarationAt(text, at).body, /credentialMember\(/, `${gate} must resolve its member through credentialMember`);
  }
  // The gate itself refuses a member turned off in the workspace, and a record nobody signs in as.
  const gate = declarationAt(read("convex/lib/membership.ts"), read("convex/lib/membership.ts").indexOf("export async function credentialMember")).body;
  assert.match(gate, /awaitsLogin\(/);
  assert.match(gate, /activeRoleIn\(/);
});

test("every table holding a credential is judged", () => {
  const schema = read("convex/schema.ts");
  const starts = [...schema.matchAll(/^ {2}(\w+): defineTable\(/gm)];
  const holding = starts.flatMap((m, i) => {
    const block = schema.slice(m.index!, starts[i + 1]?.index ?? schema.length);
    return /(?:^|[\s,{])(?:token|secret|\w*(?:[tT]oken|[kK]ey|[sS]ession|[cC]ode|[pP]assword|[sS]tate)Hash):\s*v\./m.test(block) ? [m[1]!] : [];
  });
  assert.deepEqual(holding.filter((t) => !(t in CREDENTIAL_TABLES)).sort(), [], "a table holds a credential the census doesn't judge: name its gate in CREDENTIAL_TABLES, or why it reaches no member");
  assert.deepEqual(Object.keys(CREDENTIAL_TABLES).filter((t) => !holding.includes(t)).sort(), [], "a judged table no longer holds a credential");
  for (const [table, gate] of Object.entries(CREDENTIAL_TABLES)) if (gate.startsWith("convex/")) assert.ok((GATES as readonly string[]).includes(gate), `${table}'s gate ${gate} is not a gate`);
});

test("every lookup of a credential or a signed-in member goes through a gate or is judged", () => {
  const unjudged: string[] = [];
  const seen = new Set<string>();
  for (const file of SOURCES) {
    const text = read(file);
    for (const pattern of LOOKUPS) {
      for (const m of text.matchAll(pattern)) {
        const { name, body } = declarationAt(text, m.index!);
        const key = `${file}#${name}`;
        seen.add(key);
        if ((GATES as readonly string[]).includes(key) || key in NOT_A_CREDENTIAL) continue;
        if (THROUGH_A_GATE.some((call) => body.includes(call))) continue;
        unjudged.push(`${relative(ROOT, join(ROOT, file))}#${name}`);
      }
    }
  }
  assert.deepEqual([...new Set(unjudged)].sort(), [], "a credential or signed-in identity resolves to a member without a gate: send it through credentialMember (lib/membership.ts), or judge it in NOT_A_CREDENTIAL");
  // The public export leaves Canon's operator files out; a judgment of a file that isn't here isn't stale.
  const present = (key: string) => existsSync(join(ROOT, key.split("#")[0]!));
  assert.deepEqual(Object.keys(NOT_A_CREDENTIAL).filter((k) => present(k) && !seen.has(k)).sort(), [], "a judged lookup is gone: remove it from the census");
});
