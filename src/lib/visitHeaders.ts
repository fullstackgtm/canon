export function visitHeaders(nonce?: string, localDev = false): Record<string, string> {
  return {
    "Cache-Control": "no-store, private",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Robots-Tag": "noindex, nofollow",
    "X-Frame-Options": "DENY",
    "Content-Security-Policy": `default-src 'self'; script-src 'self'${nonce ? ` 'nonce-${nonce}'` : ""}${localDev ? " 'unsafe-eval'" : ""}; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'; object-src 'none'`,
  };
}

export function visitFileHeaders(): Record<string, string> {
  return { ...visitHeaders(), "Content-Security-Policy": "sandbox; default-src 'none'; frame-ancestors 'none'; base-uri 'none'" };
}
