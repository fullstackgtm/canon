import { api } from "../../../../../convex/_generated/api";
import type { Id } from "../../../../../convex/_generated/dataModel";
import { gtmApi, readJsonBody, requireAction } from "../_lib";

export const dynamic = "force-dynamic";

function role(value: unknown) {
  return value === "admin" ||
    value === "manager" ||
    value === "rep" ||
    value === "other"
    ? value
    : undefined;
}

export const GET = gtmApi(async ({ client }) => {
  const context = await client.query(api.users.context, {});
  const members = context.users;
  const activeMembers = members.filter((member) => member.isActive);
  const managers = activeMembers.filter(
    (member) => member.role === "admin" || member.role === "manager",
  );
  const reps = activeMembers.filter((member) => member.role === "rep");

  return Response.json({
    summary: {
      members: members.length,
      activeMembers: activeMembers.length,
      managers: managers.length,
      reps: reps.length,
    },
    members,
    readiness: context.readiness,
  });
});

export const POST = gtmApi(async ({ client, request }) => {
  const body = await readJsonBody(request);
  const actionError = await requireAction(body, "update");
  if (actionError) return actionError;
  if (typeof body.userId !== "string") {
    return Response.json({ error: "userId is required" }, { status: 400 });
  }

  await client.mutation(api.users.update, {
    userId: body.userId as Id<"users">,
    name: typeof body.name === "string" ? body.name : undefined,
    title: typeof body.title === "string" ? body.title : undefined,
    role: role(body.role),
    managerId:
      typeof body.managerId === "string"
        ? (body.managerId as Id<"users">)
        : body.managerId === null
          ? null
          : undefined,
    isActive: typeof body.isActive === "boolean" ? body.isActive : undefined,
  });
  return Response.json({ ok: true });
});
