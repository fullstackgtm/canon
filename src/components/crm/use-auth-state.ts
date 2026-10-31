"use client";

import { useConvexAuth } from "convex/react";
import { LOCAL_AUTH } from "@/lib/authMode";

const DEV_MODE =
  (process.env.NODE_ENV !== "production" && !process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY) ||
  process.env.NEXT_PUBLIC_FSGTM_UI_SMOKE_BYPASS === "true";

/**
 * useConvexAuth throws under the plain dev ConvexProvider (no Clerk). In dev
 * mode the backend's demo bypass supplies the user, so report "signed in".
 * DEV_MODE is a build-time constant, so the hook order never changes.
 */
export const useAuthState: () => { isAuthenticated: boolean; isLoading: boolean } = DEV_MODE && !LOCAL_AUTH
  ? () => ({ isAuthenticated: true, isLoading: false })
  : useConvexAuth;
