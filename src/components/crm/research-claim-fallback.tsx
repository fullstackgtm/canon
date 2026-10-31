"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";

/**
 * Fallback for a sign-up redirect that lost /start/<token>/claim: the
 * homepage set an `fsgtm_rs` cookie, so resume research when the org has no
 * claimed research session yet. Onboarding ceremony only (not a GTM write
 * surface), hence it lives outside the dashboard page.
 */
export function ResearchClaimFallback({
  hasClaimedSession,
}: {
  hasClaimedSession: boolean | undefined;
}) {
  const router = useRouter();
  const tried = useRef(false);

  useEffect(() => {
    if (hasClaimedSession !== false || tried.current) return;
    const token = document.cookie.match(/(?:^|;\s*)fsgtm_rs=([a-f0-9]{32})/)?.[1];
    if (!token) return;
    tried.current = true;
    router.replace(`/start/${token}`);
  }, [hasClaimedSession, router]);

  return null;
}
