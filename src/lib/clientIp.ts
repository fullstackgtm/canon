/** Trust only the header this deployment's ingress overwrites. */
export function trustedClientIp(headers: Headers, env: Record<string, string | undefined> = process.env): string | null {
  const name = env.CANON_CLIENT_IP_HEADER?.trim().toLowerCase();
  if (!name) return null;
  const raw = headers.get(name);
  const ip = (name === "x-forwarded-for" ? raw?.split(",").at(-1) : raw)?.trim();
  return ip && /^[0-9a-fA-F:.]{2,64}$/.test(ip) ? ip : null;
}
