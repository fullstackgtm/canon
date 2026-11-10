import { redirect } from "next/navigation";
import { activateRedirectTarget } from "./redirectTarget";

/**
 * RFC 8628 verification_uri. The actual approval UX (code entry, requester
 * identity, approve/deny) already exists at /dashboard/cli-auth — this route
 * just gives the device flow its stable, memorable URL and carries the
 * ?code=XXXX-XXXX from verification_uri_complete through. It sits behind the
 * Clerk gate on purpose: unauthenticated visitors are sent through /sign-in
 * first, because only a signed-in admin/manager can approve a pairing.
 */
export default async function ActivatePage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const params = await searchParams;
  const raw = params.code;
  const code = typeof raw === "string" ? raw : Array.isArray(raw) ? raw[0] : undefined;
  redirect(activateRedirectTarget(code));
}
