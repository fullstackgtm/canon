/**
 * Where /activate (RFC 8628 verification_uri) sends the signed-in approver:
 * the existing CLI pairing approval page, carrying the user code through.
 * Kept as a plain module so tests can assert it without loading the page.
 */
export function activateRedirectTarget(code: string | undefined): string {
  return code
    ? `/dashboard/cli-auth?code=${encodeURIComponent(code)}`
    : "/dashboard/cli-auth";
}
