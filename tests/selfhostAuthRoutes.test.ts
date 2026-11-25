import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

const transition = "src/app/api/modules/transition/route.ts", github = "src/app/api/recipes/github/setup/route.ts";
function world(mode: string, signedIn: boolean) {
  const token = `header.${Buffer.from(JSON.stringify({ sub: "person|session" })).toString("base64url")}.signature`;
  const calls: string[] = [];
  let authCalls = 0;
  let evidenceSubject: unknown;
  const env = { CANON_AUTH: mode, NODE_ENV: "production", NEXT_PUBLIC_CONVEX_URL: "https://backend.test" };
  const load = (path: string): Record<string, any> => {
    const exports = {};
    const require = (id: string): any => {
      if (id.includes("serverSession")) return load("src/lib/serverSession.ts");
      if (id === "@convex-dev/auth/nextjs/server") { assert.equal(mode, "convex"); return { convexAuthNextjsToken: async () => signedIn ? token : undefined }; }
      if (id.includes("localAuth.ts")) { assert.equal(mode, "local"); return { localSession: async () => signedIn ? { user: { clerkUserId: "person|session" } } : null, mintLocalToken: () => token }; }
      if (id === "@clerk/nextjs/server") { assert.equal(mode, "clerk", "must use the active auth provider"); return { auth: async () => ({ userId: signedIn ? "person|session" : null, getToken: async () => signedIn ? token : null }) }; }
      if (id.includes("moduleEvidence")) return { evidenceSigner: () => ({}), requestIp: () => null, signEvidence: (_s: unknown, _a: unknown, _h: unknown, subject: unknown) => { evidenceSubject = subject; return "evidence"; } };
      if (id === "convex/browser") return { ConvexHttpClient: class { setAuth(t: string) { authCalls++; assert.equal(t, token); } async mutation() { calls.push("transition"); return {}; } async action() { calls.push("setup"); return { connected: [] }; } } };
      if (id === "convex/values") return { ConvexError: Error };
      if (id.includes("_generated/api")) return { api: { modules: { transition: "transition" }, githubRecipes: { completeSetup: "setup" } } };
      if (id.includes("agents/_lib")) return { siteBase: () => "https://app.test" };
      throw new Error(`Unexpected import ${id}`);
    };
    runInNewContext(ts.transpileModule(readFileSync(path, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { exports, require, process: { env }, Response, URL, URLSearchParams, Buffer });
    return exports;
  };
  return { load, calls, authCalls: () => authCalls, subject: () => evidenceSubject };
}

test("transition and GitHub setup use the active session in all three auth modes", async () => {
  for (const mode of ["convex", "local", "clerk"]) for (const signedIn of [true, false]) {
    const h = world(mode, signedIn);
    const res = await h.load(transition).POST(new Request("https://app.test/api/modules/transition", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ module: "visits", machine: "visit", name: "done", key: "one", expect: 1 }) }));
    assert.equal(res.status, signedIn ? 200 : 401);
    const setup = await h.load(github).GET(new Request("https://app.test/api/recipes/github/setup?state=state"));
    assert.equal(setup.status, 302);
    assert.equal(new URL(setup.headers.get("location")!).pathname, signedIn ? "/dashboard/customization" : "/sign-in");
    assert.equal(h.authCalls(), signedIn ? 2 : 0);
    assert.deepEqual(h.calls, signedIn ? ["transition", "setup"] : []);
    if (signedIn) assert.equal(h.subject(), "person|session");
  }
});
