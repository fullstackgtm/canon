import { api } from "../../../../../convex/_generated/api";
import { gtmApi, readJsonBody, requireAction } from "../_lib";

export const dynamic = "force-dynamic";

function syncSchedule(value: unknown) {
  return value === "daily" || value === "weekly" || value === "monthly"
    ? value
    : undefined;
}

function hierarchySource(value: unknown) {
  return value === "salesforce" ||
    value === "hubspot" ||
    value === "csv" ||
    value === "manual"
    ? value
    : undefined;
}

export const GET = gtmApi(async ({ client }) => {
  const organization = await client.query(api.organizations.current, {});
  return Response.json({ organization });
});

export const POST = gtmApi(async ({ client, request }) => {
  const body = await readJsonBody(request);
  const actionError = await requireAction(body, "updateSettings");
  if (actionError) return actionError;

  const organizationId = await client.mutation(api.organizations.updateSettings, {
    name: typeof body.name === "string" ? body.name : undefined,
    industry: typeof body.industry === "string" ? body.industry : undefined,
    fiscalYearStartMonth:
      typeof body.fiscalYearStartMonth === "number"
        ? body.fiscalYearStartMonth
        : undefined,
    defaultCurrency:
      typeof body.defaultCurrency === "string" ? body.defaultCurrency : undefined,
    timezone: typeof body.timezone === "string" ? body.timezone : undefined,
    syncSchedule: syncSchedule(body.syncSchedule),
    hierarchySource: hierarchySource(body.hierarchySource),
  });
  return Response.json({ organizationId });
});
