import { destinationProblem } from "./recordWebhooks.ts";

export function integrationUrl(base: string, path = ""): string {
  if (destinationProblem(base) || (path !== "" && !path.startsWith("/")) || path.startsWith("//") || path.includes("\\")) throw new Error("Invalid integration URL");
  const url = new URL(path ? `${base.replace(/\/$/, "")}${path}` : base);
  if (url.origin !== new URL(base).origin || url.username || url.password) throw new Error("Invalid integration URL");
  return url.href;
}

export const missingPinnedFetch: typeof fetch = async () => { throw new Error("A pinned integration transport is required"); };

export async function integrationJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new Error(`Provider returned invalid JSON (HTTP ${response.status}).`);
  }
}
