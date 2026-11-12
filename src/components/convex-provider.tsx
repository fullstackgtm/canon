"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ConvexProvider, ConvexProviderWithAuth, ConvexReactClient, useConvexAuth, useMutation } from "convex/react";
import { ConvexProviderWithClerk } from "convex/react-clerk";
import { ClerkProvider, useAuth } from "@clerk/nextjs";
import { api } from "../../convex/_generated/api";
import { ConvexAuthNextjsProvider } from "@convex-dev/auth/nextjs";
import { LOCAL_AUTH, CONVEX_AUTH } from "@/lib/authMode";

async function fetchLocalAccessToken() {
  const response = await fetch("/api/local-auth", { cache: "no-store" });
  if (!response.ok) throw new Error("Could not refresh your session");
  const { token } = await response.json();
  return typeof token === "string" ? token : null;
}

function useLocalAuth() {
  const [state, setState] = useState({ isLoading: true, isAuthenticated: false });
  const fetchAccessToken = useCallback(async () => {
    const token = await fetchLocalAccessToken();
    setState({ isLoading: false, isAuthenticated: Boolean(token) });
    return token;
  }, []);
  useEffect(() => {
    void fetchLocalAccessToken().then((token) => setState({ isLoading: false, isAuthenticated: Boolean(token) }))
      .catch(() => setState({ isLoading: false, isAuthenticated: false }));
  }, []);
  return { ...state, fetchAccessToken };
}

const DEV_MODE =
  (process.env.NODE_ENV !== "production" &&
    !process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY) ||
  process.env.NEXT_PUBLIC_FSGTM_UI_SMOKE_BYPASS === "true";

const convex = new ConvexReactClient(
  process.env.NEXT_PUBLIC_CANON_SELFHOST === "true" && typeof window !== "undefined"
    ? `${window.location.origin}/convex`
    : process.env.NEXT_PUBLIC_CONVEX_URL || "https://placeholder.convex.cloud",
);

const clerkRedirects = {
  signInUrl: "/sign-in",
  signUpUrl: "/sign-up",
  signInFallbackRedirectUrl: "/dashboard",
  signUpFallbackRedirectUrl: "/dashboard",
};

function DevDataBootstrapper() {
  const ensureWorkspace = useMutation(api.devSeed.ensureWorkspace);
  const hasRun = useRef(false);

  useEffect(() => {
    if (hasRun.current) return;
    hasRun.current = true;
    ensureWorkspace().catch((error) => {
      console.warn("Dev demo workspace was not seeded", error);
    });
  }, [ensureWorkspace]);

  return null;
}

// Dev mode: plain Convex provider without Clerk
function DevProvider({ children }: { children: React.ReactNode }) {
  return (
    <ConvexProvider client={convex}>
      <DevDataBootstrapper />
      {children}
    </ConvexProvider>
  );
}

/**
 * Hold the tree until Convex knows who is signed in. Queries re-run once auth
 * arrives, but an action fired from a mount effect while Clerk is still loading
 * goes out without a token and fails with "Not authenticated".
 */
function AwaitConvexAuth({ children }: { children: React.ReactNode }) {
  const { isLoading } = useConvexAuth();
  return isLoading ? null : <>{children}</>;
}

// Production: Clerk + Convex
function ProdProvider({ children }: { children: React.ReactNode }) {
  return (
    <ClerkProvider {...clerkRedirects}>
      <ConvexProviderWithClerk client={convex} useAuth={useAuth}>
        <AwaitConvexAuth>{children}</AwaitConvexAuth>
      </ConvexProviderWithClerk>
    </ClerkProvider>
  );
}

export function ConvexClientProvider({
  children,
  waitForAuth = true,
}: {
  children: React.ReactNode;
  waitForAuth?: boolean;
}) {
  if (CONVEX_AUTH) {
    return <ConvexAuthNextjsProvider client={convex}>{waitForAuth ? <AwaitConvexAuth>{children}</AwaitConvexAuth> : children}</ConvexAuthNextjsProvider>;
  }
  if (LOCAL_AUTH) {
    return <ConvexProviderWithAuth client={convex} useAuth={useLocalAuth}><AwaitConvexAuth>{children}</AwaitConvexAuth></ConvexProviderWithAuth>;
  }
  if (DEV_MODE) {
    return <DevProvider>{children}</DevProvider>;
  }
  return <ProdProvider>{children}</ProdProvider>;
}

export function ClerkAuthProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  if (LOCAL_AUTH || CONVEX_AUTH) return <>{children}</>;
  if (DEV_MODE) {
    return <>{children}</>;
  }

  return <ClerkProvider {...clerkRedirects}>{children}</ClerkProvider>;
}
