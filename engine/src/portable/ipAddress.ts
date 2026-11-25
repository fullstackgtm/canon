/**
 * Pure IPv4/IPv6 parsing and non-global address classification (RFC 6890).
 * Free of Node-only imports so both Node transports (`engine/src/publicHttp.ts`)
 * and default-runtime Convex modules (`convex/lib/recordWebhooks.ts`) share one
 * exact SSRF address classifier.
 */

export function parseIpv4(ip: string): [number, number, number, number] | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part) || (part.length > 1 && part.startsWith("0"))) return null;
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    octets.push(n);
  }
  return [octets[0], octets[1], octets[2], octets[3]];
}

export function ipv4OctetsArePrivate(a: number, b: number, c: number, _d: number): boolean {
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

function parseHextetList(raw: string, allowTrailingIpv4: boolean): number[] | null {
  if (!raw) return [];
  const parts = raw.split(":");
  const out: number[] = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (allowTrailingIpv4 && i === parts.length - 1 && part.includes(".")) {
      const v4 = parseIpv4(part);
      if (!v4) return null;
      out.push((v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]);
      continue;
    }
    if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
    out.push(Number.parseInt(part, 16));
  }
  return out;
}

/** Parse a bare IPv6 literal (no brackets, no zone ID) into 8 16-bit hextets, or null if invalid. */
export function parseIpv6Hextets(ip: string): number[] | null {
  if (!ip.includes(":") || ip.includes("%")) return null;
  const lower = ip.toLowerCase();
  const halves = lower.split("::");
  if (halves.length > 2) return null;
  if (halves.length === 1) {
    const hextets = parseHextetList(halves[0], true);
    return hextets && hextets.length === 8 ? hextets : null;
  }
  const left = parseHextetList(halves[0], false);
  const right = parseHextetList(halves[1], true);
  if (!left || !right) return null;
  const missing = 8 - (left.length + right.length);
  if (missing < 1) return null;
  return [...left, ...new Array<number>(missing).fill(0), ...right];
}

function embeddedIpv4IsPrivate(hi: number, lo: number): boolean {
  return ipv4OctetsArePrivate(hi >> 8, hi & 255, lo >> 8, lo & 255);
}

export function ipv6HextetsArePrivate(h: readonly number[]): boolean {
  if (h.length !== 8) return true;
  const [h0, h1, h2, h3, h4, h5, h6, h7] = h;
  // Unspecified (::/128), loopback (::1/128), and deprecated IPv4-compatible (::/96).
  if (h0 === 0 && h1 === 0 && h2 === 0 && h3 === 0 && h4 === 0 && h5 === 0) return true;
  // IPv4-mapped (::ffff:0:0/96): classify by the embedded IPv4 address.
  if (h0 === 0 && h1 === 0 && h2 === 0 && h3 === 0 && h4 === 0 && h5 === 0xffff) {
    return embeddedIpv4IsPrivate(h6, h7);
  }
  // IPv4-translated SIIT (::ffff:0:0:0/96, RFC 2765).
  if (h0 === 0 && h1 === 0 && h2 === 0 && h3 === 0 && h4 === 0xffff && h5 === 0) return true;
  // NAT64 well-known (64:ff9b::/96, RFC 6052) and local-use (64:ff9b:1::/48, RFC 8215).
  if (h0 === 0x0064 && h1 === 0xff9b && h2 === 0 && h3 === 0 && h4 === 0 && h5 === 0) return true;
  if (h0 === 0x0064 && h1 === 0xff9b && h2 === 0x0001) return true;
  // Discard-only (100::/64).
  if (h0 === 0x0100 && h1 === 0 && h2 === 0 && h3 === 0) return true;
  // Teredo (2001::/32), benchmarking (2001:2::/48), ORCHID/ORCHIDv2 (2001:10::/28, 2001:20::/28), documentation (2001:db8::/32).
  if (h0 === 0x2001) {
    if (h1 === 0 || h1 === 0x0db8) return true;
    if (h1 === 0x0002 && h2 === 0) return true;
    if ((h1 & 0xfff0) === 0x0010 || (h1 & 0xfff0) === 0x0020) return true;
  }
  // Documentation (3fff::/20, RFC 9637).
  if (h0 === 0x3fff && (h1 & 0xf000) === 0) return true;
  // 6to4 (2002::/16): classify by the embedded IPv4 address.
  if (h0 === 0x2002) return embeddedIpv4IsPrivate(h1, h2);
  // Unique local (fc00::/7), link-local (fe80::/10), deprecated site-local (fec0::/10), multicast (ff00::/8).
  if ((h0 & 0xfe00) === 0xfc00) return true;
  if ((h0 & 0xffc0) === 0xfe80) return true;
  if ((h0 & 0xffc0) === 0xfec0) return true;
  if ((h0 & 0xff00) === 0xff00) return true;
  return false;
}

/** Whether an IP literal (IPv4 or IPv6) is non-global / private / reserved. Fails closed on invalid input. */
export function ipIsPrivate(ip: string): boolean {
  const v4 = parseIpv4(ip);
  if (v4) return ipv4OctetsArePrivate(v4[0], v4[1], v4[2], v4[3]);
  const v6 = parseIpv6Hextets(ip);
  if (v6) return ipv6HextetsArePrivate(v6);
  return true;
}

/** Whether an IP literal is strictly loopback (127.0.0.0/8, ::1, or IPv4-mapped loopback). */
export function ipIsLoopback(ip: string): boolean {
  const v4 = parseIpv4(ip);
  if (v4) return v4[0] === 127;
  const v6 = parseIpv6Hextets(ip);
  if (!v6) return false;
  if (v6[0] === 0 && v6[1] === 0 && v6[2] === 0 && v6[3] === 0 && v6[4] === 0 && v6[5] === 0 && v6[6] === 0 && v6[7] === 1) {
    return true;
  }
  return v6[0] === 0 && v6[1] === 0 && v6[2] === 0 && v6[3] === 0 && v6[4] === 0 && v6[5] === 0xffff && (v6[6] >> 8) === 127;
}
