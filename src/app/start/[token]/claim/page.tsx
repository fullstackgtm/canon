"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useMutation, useQuery } from "convex/react";
import { useAuthState } from "@/components/crm/use-auth-state";
import {
  CreateOrganization,
  OrganizationList,
  useAuth,
  useOrganizationList,
} from "@clerk/nextjs";
import { Loader2 } from "lucide-react";
import { api } from "../../../../../convex/_generated/api";
import { getErrorMessage } from "@/lib/utils";
import { LOCAL_AUTH } from "@/lib/authMode";

const DEV_MODE =
  (process.env.NODE_ENV !== "production" &&
    !process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY) ||
  process.env.NEXT_PUBLIC_FSGTM_UI_SMOKE_BYPASS === "true";

const RETRY_MS = 2500;
const MAX_ATTEMPTS = 16;

function clearResearchCookie() {
  document.cookie = "fsgtm_rs=; Path=/; Max-Age=0; SameSite=Lax";
}

function WorkspaceProvisioner({
  name,
  returnPath,
  onReady,
}: {
  name: string;
  returnPath: string;
  onReady: (ready: boolean) => void;
}) {
  const { orgId } = useAuth();
  const { isLoaded, createOrganization, setActive, userMemberships } =
    useOrganizationList({ userMemberships: true });
  const started = useRef(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!isLoaded) return;
    if (orgId) {
      onReady(true);
      return;
    }
    if (
      userMemberships.isLoading ||
      started.current ||
      (userMemberships.data?.length ?? 0) > 1
    )
      return;
    started.current = true;
    void (async () => {
      const existing = userMemberships.data?.[0]?.organization;
      const organization = existing ?? (await createOrganization({ name }));
      await setActive({ organization: organization.id });
    })().catch(() => setFailed(true));
  }, [
    isLoaded,
    orgId,
    userMemberships.isLoading,
    userMemberships.data,
    createOrganization,
    setActive,
    name,
    onReady,
  ]);

  if (!orgId && (userMemberships.data?.length ?? 0) > 1)
    return (
      <OrganizationList
        hidePersonal
        afterSelectOrganizationUrl={returnPath}
        afterCreateOrganizationUrl={returnPath}
      />
    );

  return failed ? (
    <CreateOrganization
      afterCreateOrganizationUrl={returnPath}
      skipInvitationScreen
    />
  ) : null;
}

export default function ClaimPage() {
  const { token } = useParams<{ token: string }>();
  const router = useRouter();
  const { isAuthenticated, isLoading } = useAuthState();
  const session = useQuery(api.researchSessions.get, { token });
  const allowed = useQuery(
    api.researchSessions.claimAccess,
    isAuthenticated ? { token } : "skip",
  );
  const claim = useMutation(api.researchSessions.claim);
  const [error, setError] = useState("");
  const [workspaceReady, setWorkspaceReady] = useState(LOCAL_AUTH || DEV_MODE);
  const attempts = useRef(0);
  const started = useRef(false);

  useEffect(() => {
    if (
      !workspaceReady ||
      (!allowed && !session?.claimed) ||
      isLoading ||
      !isAuthenticated ||
      started.current ||
      session?.status !== "ready" ||
      (!session.invited && !session.claimed)
    )
      return;
    started.current = true;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const attempt = async () => {
      if (cancelled) return;
      attempts.current += 1;
      try {
        const result = await claim({ token });
        if (cancelled) return;
        clearResearchCookie();
        router.replace(result.redirect);
      } catch (cause) {
        if (cancelled) return;
        const message = getErrorMessage(cause);
        if (
          /not authenticated/i.test(message) &&
          attempts.current < MAX_ATTEMPTS
        ) {
          timer = setTimeout(attempt, RETRY_MS);
          return;
        }
        clearResearchCookie();
        setError(message);
      }
    };
    void attempt();
    return () => {
      cancelled = true;
      started.current = false;
      if (timer) clearTimeout(timer);
    };
  }, [
    isLoading,
    isAuthenticated,
    claim,
    token,
    router,
    session?.status,
    session?.invited,
    session?.claimed,
    workspaceReady,
    allowed,
  ]);

  useEffect(() => {
    if (
      session === null ||
      (session &&
        (session.status !== "ready" || (!session.invited && !session.claimed)))
    )
      router.replace(`/start/${token}`);
  }, [session, router, token]);

  if (!session || (!session.invited && !session.claimed))
    return (
      <main className="mx-auto max-w-md px-6 py-24">
        <h1 className="font-display text-2xl">
          Your workspace opens by invitation.
        </h1>
        <Link
          className="mt-4 inline-block underline"
          href={`/start/${token}?phase=waitlist`}
        >
          Join the waitlist and keep your research
        </Link>
      </main>
    );

  if (!isLoading && !isAuthenticated) {
    const back = `/start/${token}/claim`;
    return (
      <main className="mx-auto max-w-md px-6 py-24 text-center">
        <h1 className="font-display text-2xl font-semibold">
          Sign in to keep your TAM
        </h1>
        <div className="mt-6 flex justify-center gap-4">
          <Link
            className="bg-primary px-5 py-2.5 text-xs font-medium text-primary-foreground"
            href={`/api/lead-magnet/invite?token=${token}`}
          >
            Sign up
          </Link>
          <Link
            className="px-5 py-2.5 text-sm underline"
            href={`/sign-in?redirect_url=${encodeURIComponent(back)}`}
          >
            Sign in
          </Link>
        </div>
      </main>
    );
  }

  if (isAuthenticated && allowed !== true && !session.claimed)
    return (
      <main className="mx-auto max-w-md px-6 py-24">
        <h1 className="font-display text-2xl">
          {allowed === undefined
            ? "Checking your invitation…"
            : "Sign in with the verified email on your invitation."}
        </h1>
        <Link className="mt-4 inline-block underline" href={`/start/${token}`}>
          Back to your research
        </Link>
      </main>
    );

  return (
    <main className="mx-auto max-w-lg px-6 py-24 text-center">
      {error ? (
        <>
          <h1 className="font-display text-2xl font-semibold">
            Could not add this TAM
          </h1>
          <p className="mt-2 text-sm text-destructive">{error}</p>
          <div className="mt-6 flex justify-center gap-4 text-sm">
            <Link className="underline" href={`/start/${token}`}>
              Back to results
            </Link>
            <Link className="underline" href="/dashboard/accounts">
              Go to my TAM
            </Link>
          </div>
        </>
      ) : (
        <>
          <Loader2 className="mx-auto h-6 w-6 animate-spin" />
          <h1 className="mt-4 font-display text-2xl font-semibold">
            Setting up your workspace…
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Copying your TAM in. You will land on your fit-sorted accounts.
          </p>
          {!LOCAL_AUTH && !DEV_MODE && allowed && (
            <div className="mt-8 flex justify-center text-left">
              <WorkspaceProvisioner
                name={session.companyFinding?.name || session.domain}
                returnPath={`/start/${token}/claim`}
                onReady={setWorkspaceReady}
              />
            </div>
          )}
        </>
      )}
    </main>
  );
}
