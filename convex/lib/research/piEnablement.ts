import { integrationEnabled } from "../integrationsAvailable.ts";
export function piResearchEnabled(orgId: string): boolean {
  return integrationEnabled("pi")
    && (process.env.CANON_PI_RESEARCH_ORGS ?? "").split(",").map((id) => id.trim()).includes(orgId);
}

export function piFixtureRun(run: { piFixture?: string }): boolean {
  return process.env.CANONCRM_LOCAL_STACK === "true" && process.env.FSGTM_ENABLE_DEMO_DATA === "true" && run.piFixture === "account-text";
}

export function piWorkerUrl(): URL {
  const url = new URL(process.env.CANON_PI_URL ?? "");
  const local = process.env.CANONCRM_LOCAL_STACK === "true" && process.env.FSGTM_ENABLE_DEMO_DATA === "true" && url.protocol === "http:" && url.hostname === "127.0.0.1";
  if ((!local && url.protocol !== "https:") || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("Invalid Pi Worker origin");
  return url;
}
