import type { FunctionArgs, FunctionReturnType } from "convex/server";
import { api } from "../../convex/_generated/api.js";

type OpArgs = FunctionArgs<typeof api.modules.op>;
type ModuleOpClient = {
  query(ref: typeof api.modules.describe, args: FunctionArgs<typeof api.modules.describe>): Promise<FunctionReturnType<typeof api.modules.describe>>;
  mutation(ref: typeof api.modules.op, args: OpArgs): Promise<FunctionReturnType<typeof api.modules.op>>;
  action(ref: typeof api.modules.writeOp, args: OpArgs): Promise<FunctionReturnType<typeof api.modules.writeOp>>;
};

/** App and backend deploy separately. Existing module writes keep working before record-ref support arrives. */
export async function runModuleOp(client: ModuleOpClient, args: OpArgs) {
  const described = await client.query(api.modules.describe, { module: args.module });
  return described.recordRefs ? client.action(api.modules.writeOp, args) : client.mutation(api.modules.op, args);
}
