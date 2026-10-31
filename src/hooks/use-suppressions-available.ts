"use client";

import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";

/** New endpoints wait for the stable context query to advertise support. */
export function useSuppressionsAvailable() {
  return useQuery(api.organizations.context)?.features?.suppressions === true;
}
