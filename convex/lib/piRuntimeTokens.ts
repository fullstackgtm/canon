export type WatchTicket = { runId: string; viewerId: string; expiresAt: number };

export async function piServiceHeaders(secret: string, method: string, path: string, now = Date.now()): Promise<Record<string, string>> {
  const timestamp = String(now);
  return { "X-Canon-Pi-Time": timestamp, "X-Canon-Pi-Signature": await signPiCallback(secret, `service\n${method}\n${path}`, timestamp) };
}

export async function verifyPiService(secret: string, method: string, path: string, headers: Headers, now = Date.now()): Promise<boolean> {
  return verifyPiCallback(secret, `service\n${method}\n${path}`, headers.get("X-Canon-Pi-Time"), headers.get("X-Canon-Pi-Signature"), now);
}

const encoder = new TextEncoder();
const hex = (bytes: ArrayBuffer) => Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");

export async function signWatchTicket(secret: string, runId: string, viewerId: string, now = Date.now()): Promise<string> {
  const payload = btoa(JSON.stringify({ runId, viewerId, expiresAt: now + 60_000 })).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return `${payload}.${hex(await crypto.subtle.sign("HMAC", key, encoder.encode(payload)))}`;
}

export async function verifyWatchTicket(secret: string, ticket: string, runId: string, now = Date.now()): Promise<WatchTicket | null> {
  try {
    if (!secret || ticket.length > 2048) return null;
    const parts = ticket.split(".");
    if (parts.length !== 2 || !/^[0-9a-f]{64}$/.test(parts[1])) return null;
    const signature = Uint8Array.from(parts[1].match(/../g)!, (v) => parseInt(v, 16));
    const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
    if (!await crypto.subtle.verify("HMAC", key, signature, encoder.encode(parts[0]))) return null;
    const value = JSON.parse(atob(parts[0].replaceAll("-", "+").replaceAll("_", "/"))) as Partial<WatchTicket>;
    return value.runId === runId && typeof value.viewerId === "string" && typeof value.expiresAt === "number" && value.expiresAt > now && value.expiresAt <= now + 120_000 ? value as WatchTicket : null;
  } catch { return null; }
}

export async function signPiCallback(secret: string, body: string, timestamp: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, encoder.encode(`canon.pi.callback.v1\n${timestamp}\n${body}`)));
}

export async function verifyPiCallback(secret: string, body: string, timestamp: string | null, signature: string | null, now = Date.now()): Promise<boolean> {
  if (!secret || !timestamp || !/^\d{13}$/.test(timestamp) || Math.abs(now - Number(timestamp)) > 60_000 || !signature || !/^[0-9a-f]{64}$/.test(signature)) return false;
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  return crypto.subtle.verify("HMAC", key, Uint8Array.from(signature.match(/../g)!, (s) => parseInt(s, 16)), encoder.encode(`canon.pi.callback.v1\n${timestamp}\n${body}`));
}
