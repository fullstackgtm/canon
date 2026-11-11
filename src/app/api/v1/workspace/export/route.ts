/**
 * Workspace export for `canon workspace export` and `canon workspace verify` (convex/workspaceTransfer.ts). The bearer
 * is an export key an admin created in Settings > Workspace, never a CLI or agent token: the key names the workspace,
 * and Convex re-checks its admin on every call. The plan carries what this deployment's data is: the commit it runs
 * and the data epoch of scripts/selfhost/data-contract.json.
 */
import { ConvexHttpClient } from "convex/browser";
import { z } from "zod";
import { api } from "../../../../../../convex/_generated/api.js";
import { explainConvexError } from "../../../../../lib/convexErrorText.ts";
import { parseContract } from "../../../../../../scripts/selfhost/releases.mjs";
import dataContract from "../../../../../../scripts/selfhost/data-contract.json";

export const dynamic = "force-dynamic";

const Body = z.discriminatedUnion("op", [
  z.object({ op: z.literal("plan") }),
  z.object({ op: z.literal("registerInfo") }),
  z.object({
    op: z.literal("page"), section: z.string().max(100), cursor: z.string().max(10_000).nullable().optional(), numItems: z.number().int().min(1).max(512).optional(),
    parents: z.array(z.string().max(64)).max(50).optional(), parentId: z.string().max(64).optional(), countOnly: z.boolean().optional(),
  }),
  z.object({ op: z.literal("register"), section: z.enum(["register.accounts", "register.contacts", "register.field_history"]), after: z.string().max(200).optional(), limit: z.number().int().min(1).max(2000).optional() }),
  z.object({ op: z.literal("files"), rows: z.array(z.object({ section: z.string().max(100), id: z.string().max(64) })).max(100) }),
]);

const withoutOp = <T extends { op: string }>(body: T): Omit<T, "op"> => Object.fromEntries(Object.entries(body).filter(([k]) => k !== "op")) as Omit<T, "op">;
const error = (status: number, message: string) => Response.json({ error: { message } }, { status, headers: { "cache-control": "no-store" } });

export async function POST(request: Request): Promise<Response> {
  const url = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!url) return error(503, "NEXT_PUBLIC_CONVEX_URL is not configured");
  const key = request.headers.get("authorization")?.match(/^Bearer\s+(cwx_\S+)$/)?.[1];
  if (!key) return error(401, "Pass the export key from Settings > Workspace as the Bearer token");
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return error(400, "The body is not an export request");
  const convex = new ConvexHttpClient(url);
  const body = parsed.data;
  try {
    let result: unknown;
    if (body.op === "plan") {
      const contract = parseContract(JSON.stringify(dataContract));
      result = { ...(await convex.query(api.workspaceTransfer.exportPlan, { key })), source: { appCommit: process.env.RELEASE_GIT_SHA ?? null, dataEpoch: contract.epoch, minEpoch: contract.minEpoch } };
    } else if (body.op === "registerInfo") {
      result = await convex.action(api.workspaceTransfer.exportRegisterInfo, { key });
    } else if (body.op === "page") {
      result = await convex.query(api.workspaceTransfer.exportPage, { key, ...withoutOp(body) });
    } else if (body.op === "files") {
      result = await convex.query(api.workspaceTransfer.exportFiles, { key, rows: body.rows });
    } else {
      result = await convex.action(api.workspaceTransfer.exportRegister, { key, ...withoutOp(body) });
    }
    return Response.json(result, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    const explained = explainConvexError(e);
    if (explained.kind === "rejected") return error(403, explained.message);
    return error(500, `Export failed${explained.requestId ? ` (request ${explained.requestId})` : ""}: ${explained.message}`.slice(0, 500));
  }
}

const deny = () => error(405, "Use POST");
export { deny as GET, deny as PATCH, deny as PUT, deny as DELETE };
