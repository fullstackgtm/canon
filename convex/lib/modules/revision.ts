import { ConvexError } from "convex/values";

export const superseded = () => new ConvexError({
  kind: "module_superseded",
  message: "This module was upgraded while the call was running. Retry the call.",
});

export function isSuperseded(error: unknown): boolean {
  return error instanceof ConvexError && typeof error.data === "object" && error.data !== null && "kind" in error.data && error.data.kind === "module_superseded";
}

export function moduleErrorMessage(error: unknown): string {
  if (error instanceof ConvexError) {
    const data = error.data;
    return typeof data === "object" && data !== null && "message" in data && typeof data.message === "string" ? data.message : String(data);
  }
  return error instanceof Error ? error.message : String(error);
}
