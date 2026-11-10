/**
 * Workspace import for `canon workspace import` (convex/workspaceImport.ts). The bearer is an import key an admin
 * created in Settings > Workspace, never an export key, CLI or agent token: the key names the workspace, and Convex
 * re-checks its admin on every call. The plan refuses an archive whose data this deployment can't read, by the data
 * epochs of scripts/selfhost/data-contract.json, as selfhost:restore does.
 */
import { ConvexHttpClient } from "convex/browser";
import { z } from "zod";
import { api } from "../../../../../../convex/_generated/api.js";
import { explainConvexError } from "../../../../../lib/convexErrorText.ts";
import { sourceRefusals } from "../../../../../lib/workspaceImportSource.ts";

export const dynamic = "force-dynamic";

const line = z.string().max(1_000_000);
const Body = z.discriminatedUnion("op", [
  z.object({ op: z.literal("plan"), source: z.object({ dataEpoch: z.number().int().min(0), minEpoch: z.number().int().min(0), recordContract: z.string().max(64).nullable() }).passthrough() }),
  z.object({ op: z.literal("begin"), digest: z.string().regex(/^[0-9a-f]{64}$/), sourceWorkspaceId: z.string().max(64), registerRows: z.number().int().min(0) }),
  z.object({ op: z.literal("users"), offset: z.number().int().min(0), rows: z.array(line).max(200), formerIds: z.array(z.string().max(64)).max(200), pass: z.literal(2).optional() }),
  z.object({ op: z.literal("page"), section: z.string().max(100), offset: z.number().int().min(0), rows: z.array(line).max(100), pass: z.literal(2).optional() }),
  z.object({ op: z.literal("register"), section: z.enum(["register.accounts", "register.contacts", "register.field_history"]), offset: z.number().int().min(0), rows: z.array(line).max(1000) }),
  z.object({ op: z.literal("finish"), expected: z.record(z.string().max(120), z.number().int().min(0)) }),
]);

const withoutOp = <T extends { op: string }>(body: T): Omit<T, "op"> => Object.fromEntries(Object.entries(body).filter(([k]) => k !== "op")) as Omit<T, "op">;
const error = (status: number, message: string) => Response.json({ error: { message } }, { status, headers: { "cache-control": "no-store" } });

export async function POST(request: Request): Promise<Response> {
  const url = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!url) return error(503, "NEXT_PUBLIC_CONVEX_URL is not configured");
  const key = request.headers.get("authorization")?.match(/^Bearer\s+(cwi_\S+)$/)?.[1];
  if (!key) return error(401, "Pass the import key from Settings > Workspace as the Bearer token");
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return error(400, "The body is not an import request");
  const convex = new ConvexHttpClient(url);
  const body = parsed.data;
  try {
    let result: unknown;
    if (body.op === "plan") result = { ...(await convex.query(api.workspaceImport.importPlan, { key })), refusals: sourceRefusals(body.source) };
    else if (body.op === "begin") result = await convex.action(api.workspaceImport.begin, { key, ...withoutOp(body) });
    else if (body.op === "users") result = await convex.mutation(api.workspaceImport.importUsers, { key, ...withoutOp(body) });
    else if (body.op === "page") result = await convex.mutation(api.workspaceImport.importPage, { key, ...withoutOp(body) });
    else if (body.op === "register") result = await convex.action(api.workspaceImport.importRegister, { key, ...withoutOp(body) });
    else result = await convex.mutation(api.workspaceImport.finish, { key, ...withoutOp(body) });
    return Response.json(result, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    const explained = explainConvexError(e);
    if (explained.kind === "rejected") return error(403, explained.message);
    return error(500, `Import failed${explained.requestId ? ` (request ${explained.requestId})` : ""}: ${explained.message}`.slice(0, 2000));
  }
}

const deny = () => error(405, "Use POST");
export { deny as GET, deny as PATCH, deny as PUT, deny as DELETE };
