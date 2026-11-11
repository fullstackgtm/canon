/**
 * Census: every credential Canon accepts resolves to a member through one gate, lib/membership.ts credentialMember,
 * which refuses a member who isn't active in the workspace the credential acts in. It lists every table holding a
 * credential, every lookup of one by its secret, every lookup of a member by sign-in id and every read of the
 * signed-in identity, and fails on one it doesn't judge, so the next credential type can't skip the gate.
 * tests/deactivatedMemberAccess.test.ts proves the gate's behavior through each path.
 *
 * A credential Canon reads back (a provider token, a webhook URL or secret) is stored sealed: its field's validator
 * is lib/sealed.ts sealedV, so a write of anything but lib/tokenHelpers.ts encryptForStorage's result fails the
 * typecheck. The last test lists every such field and fails on a new one that isn't sealed or judged, and on a cast.
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
  automationWebhookSecrets: "signs what starts an automation rule; the run acts as its approver, refused once they leave (automations.ts startOnDemand)",
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
    return /(?:^|[\s,{])(?:token|secret|\w*(?:[tT]oken|[kK]ey|[sS]ession|[cC]ode|[pP]assword|[sS]tate)Hash):\s*(?:v\.|sealedV)/m.test(block) ? [m[1]!] : [];
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

/** Each stored field holding a credential Canon reads back: sealed, or why it is kept as it is. */
const STORED_CREDENTIALS: Record<string, "sealed" | string> = {
  "integrations.accessToken": "sealed",
  "integrations.refreshToken": "sealed",
  "integrations.clientCredentials": "sealed",
  "chatgptAuth.deviceAuthId": "sealed",
  "chatgptAuth.accessToken": "sealed",
  "chatgptAuth.refreshToken": "sealed",
  "chatgptAuth.idToken": "sealed",
  "agentWebhooks.secret": "sealed",
  "automationWebhookSecrets.secret": "sealed",
  "recordWebhookEndpoints.secret": "sealed",
  "outboundTargets.url": "sealed",
  "outboundTargets.secret": "sealed",
  "connectorLinks.secret": "sealed",
  "operatorGithubApps.encryptedClientSecret": "sealed",
  "operatorGithubApps.encryptedPrivateKey": "sealed",
  "operatorGithubApps.encryptedWebhookSecret": "sealed",
  "moduleFiles.secret": "a one-time upload ticket the upload route matches by value; cleared once the file is recorded",
  "researchSessions.token": "a public research link's id, looked up by value",
  "researchSessions.cachedFromToken": "the public research link a session was copied from",
  "signalBoards.token": "a public job board's id, not a credential",
  "emailLogAddresses.token": "the logging address itself, looked up by value",
};
/** The only places that make a Sealed without encrypting: the brand itself, and the local stack's fake demo tokens. */
const SEALED_CASTS = ["convex/lib/sealed.ts", "convex/lib/tokenHelpers.ts", "convex/devSeed.ts"];

test("every stored credential is sealed or judged, and only encryptForStorage seals one", () => {
  const fields = new Map<string, string>();
  // The public export leaves Canon's operator tables out.
  const operator = existsSync(join(ROOT, "convex/lib/operatorTables.ts"));
  for (const file of ["convex/schema.ts", ...(operator ? ["convex/lib/operatorTables.ts"] : [])]) {
    let table = "";
    for (const line of read(file).split("\n")) {
      table = /^ {2}(\w+): defineTable\(/.exec(line)?.[1] ?? table;
      const field = /^ {4}(\w+): (.*)/.exec(line);
      if (table && field) fields.set(`${table}.${field[1]}`, field[2]!);
    }
  }
  const named = [...fields.keys()].filter((key) => /\.(?:\w*[a-z])?(?:[tT]oken|[sS]ecret|[cC]redentials|AuthId)$|\.encrypted[A-Z]/.test(key));
  assert.deepEqual(named.filter((key) => !(key in STORED_CREDENTIALS)).sort(), [], "a stored credential isn't judged: seal it (lib/sealed.ts sealedV, written with encryptForStorage), or say why it is kept as it is");
  for (const [key, judged] of Object.entries(STORED_CREDENTIALS)) {
    if (!operator && key.startsWith("operatorGithubApps.")) continue;
    assert.ok(fields.has(key), `${key} is gone: update the census`);
    if (judged === "sealed") assert.match(fields.get(key)!, /^(?:v\.optional\()?sealedV\b/, `${key} must use sealedV`);
    else assert.ok(key.split(".")[0]! in CREDENTIAL_TABLES, `${key} is kept as it is, so the credential census must judge its table`);
  }
  for (const file of files("convex")) {
    const text = read(file);
    if (/\bas Sealed\b|VString<Sealed>/.test(text)) assert.ok(SEALED_CASTS.includes(file), `${file} makes a Sealed without encrypting: use encryptForStorage`);
    if (/\bencryptToken\(/.test(text)) assert.ok(["convex/lib/encryption.ts", "convex/lib/tokenHelpers.ts"].includes(file), `${file} encrypts around encryptForStorage`);
  }
});
