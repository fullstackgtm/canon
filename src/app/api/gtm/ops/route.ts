import { api } from "../../../../../convex/_generated/api";
import { gtmApi, readJsonBody } from "../_lib";

export const dynamic = "force-dynamic";

export const GET = gtmApi(async ({ client, url }) => {
  const resource = url.searchParams.get("resource");
  if (!resource) {
    const registry = await client.query(api.gtm.describe, {});
    return Response.json(registry);
  }

  const argsParam = url.searchParams.get("args");
  const args = argsParam ? JSON.parse(argsParam) : {};
  const result = await client.query(api.gtm.find, { resource, args });
  return Response.json({ resource, result });
});

export const POST = gtmApi(async ({ client, request }) => {
  const body = await readJsonBody(request);
  const verb = typeof body.verb === "string" ? body.verb : body.kind;
  const args = body.args && typeof body.args === "object" ? body.args : {};
  const mode = body.mode === "apply" ? "apply" : "dry_run";
  const reason = typeof body.reason === "string" ? body.reason : undefined;

  if (verb === "find") {
    if (typeof body.resource !== "string") {
      return Response.json({ error: "resource is required" }, { status: 400 });
    }
    const result = await client.query(api.gtm.find, {
      resource: body.resource,
      args,
    });
    return Response.json({ resource: body.resource, result });
  }

  if (verb === "set") {
    if (typeof body.operation !== "string") {
      return Response.json({ error: "operation is required" }, { status: 400 });
    }
    const result = await client.mutation(api.gtm.set, {
      operation: body.operation,
      args,
      mode,
      reason,
    });
    return Response.json({ operation: body.operation, result });
  }

  if (verb === "do") {
    if (typeof body.action !== "string") {
      return Response.json({ error: "action is required" }, { status: 400 });
    }
    const result = await client.action(api.gtm.doAction, {
      action: body.action,
      args,
      mode,
      reason,
    });
    return Response.json({ action: body.action, result });
  }

  if (verb === "parse") {
    if (typeof body.inputType !== "string" || !("input" in body)) {
      return Response.json(
        { error: "inputType and input are required" },
        { status: 400 },
      );
    }
    const result = await client.action(api.gtm.parse, {
      inputType: body.inputType,
      input: body.input,
      mode,
    });
    return Response.json({ inputType: body.inputType, result });
  }

  return Response.json(
    { error: "verb must be find, set, do, or parse" },
    { status: 400 },
  );
});
