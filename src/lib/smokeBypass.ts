import { createHash, timingSafeEqual } from "node:crypto";

export function smokeBypassAllowed(headers: Headers, env: Record<string, string | undefined> = process.env): boolean {
  if (env.NODE_ENV === "production") return false;
  const token = env.FSGTM_SMOKE_BYPASS_TOKEN ?? env.FSGTM_UI_SMOKE_BYPASS_TOKEN;
  if (!token) return false;
  const digest = (s: string) => createHash("sha256").update(s).digest();
  return ["x-fsgtm-smoke-bypass", "x-fsgtm-ui-smoke"].some((name) => timingSafeEqual(digest(headers.get(name) ?? ""), digest(token)));
}
