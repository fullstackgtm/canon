import { startMcpServer } from "../engine/src/mcp.ts";

startMcpServer().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
