import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { buildSync } from "esbuild";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const require = createRequire(import.meta.url);
const token = "a".repeat(32);
class Redirect extends Error {
  location: string;
  constructor(location: string) {
    super(location);
    this.location = location;
  }
}
function load(entry: string, invited: boolean, cookie?: string) {
  const source = buildSync({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: "cjs",
    platform: "node",
    jsx: "automatic",
    external: [
      "react",
      "react/*",
      "next/*",
      "@clerk/nextjs",
      "@/components/convex-provider",
      "*/convex/_generated/api",
      "../../api/cli/_lib",
      "../../cli/_lib",
    ],
  }).outputFiles[0].text;
  const stubs: Record<string, unknown> = {
    "next/navigation": {
      redirect: (location: string) => {
        throw new Redirect(location);
      },
    },
    "next/headers": {
      cookies: async () => ({
        get: () => (cookie ? { value: cookie } : undefined),
      }),
    },
    "@clerk/nextjs": {
      SignUp: ({
        routing,
        forceRedirectUrl,
      }: {
        routing: string;
        forceRedirectUrl: string;
      }) =>
        createElement("div", {
          "data-routing": routing,
          "data-redirect": forceRedirectUrl,
        }),
    },
    "@/components/convex-provider": {
      ClerkAuthProvider: ({ children }: { children: ReactNode }) => children,
    },
  };
  const exports: {
    default: (args: {
      searchParams: Promise<Record<string, string>>;
    }) => Promise<ReactNode>;
    GET: (request: Request) => Promise<Response>;
  } = {
    default: async () => {
      throw new Error("Page export missing");
    },
    GET: async () => {
      throw new Error("Route export missing");
    },
  };
  const compiled = { exports };
  runInNewContext(source, {
    module: compiled,
    exports,
    URL,
    Response,
    Headers,
    process: { env: { NODE_ENV: "production" } },
    require: (id: string) => {
      if (Object.hasOwn(stubs, id)) return stubs[id];
      if (id.endsWith("_generated/api"))
        return { api: { researchSessions: { get: "get" } } };
      if (id.endsWith("cli/_lib"))
        return {
          plainConvexClient: () => ({ query: async () => ({ invited }) }),
          rateLimit: () => true,
        };
      return require(id);
    },
  });
  return compiled.exports;
}

test("invited signup persists authorization across Clerk steps without reopening public signup", async () => {
  const entry = "src/app/sign-up/[[...sign-up]]/page.tsx";
  await assert.rejects(
    load(entry, false).default({ searchParams: Promise.resolve({}) }),
    (error) => error instanceof Redirect && error.location === "/",
  );
  await assert.rejects(
    load(entry, true).default({
      searchParams: Promise.resolve({ research: token }),
    }),
    (error) =>
      error instanceof Redirect &&
      error.location === `/api/lead-magnet/invite?token=${token}`,
  );
  const continued = await load(entry, true, token).default({
    searchParams: Promise.resolve({}),
  });
  const html = renderToStaticMarkup(continued);
  assert.ok(html.includes('data-routing="hash"'));
  assert.ok(html.includes(`/start/${token}/claim`));
  await assert.rejects(
    load(entry, false, token).default({ searchParams: Promise.resolve({}) }),
    (error) =>
      error instanceof Redirect && error.location.startsWith(`/start/${token}`),
  );
  assert.ok(
    renderToStaticMarkup(
      await load(entry, false).default({
        searchParams: Promise.resolve({ __clerk_ticket: "ticket" }),
      }),
    ).includes('data-routing="hash"'),
  );
});

test("the invitation entry route sets an HTTP-only scoped cookie only after validating the session", async () => {
  const entry = "src/app/api/lead-magnet/invite/route.ts";
  assert.equal(
    (
      await load(entry, false).GET(
        new Request(`http://localhost/api/lead-magnet/invite?token=${token}`),
      )
    ).status,
    403,
  );
  const response = await load(entry, true).GET(
    new Request(`http://localhost/api/lead-magnet/invite?token=${token}`),
  );
  assert.equal(response.status, 303);
  const cookie = response.headers.get("set-cookie") ?? "";
  for (const part of ["HttpOnly", "Path=/sign-up", "SameSite=Lax", "Secure"])
    assert.ok(cookie.includes(part));
  assert.equal(
    new URL(response.headers.get("location")!).searchParams.get("redirect_url"),
    `/start/${token}/claim`,
  );
});
