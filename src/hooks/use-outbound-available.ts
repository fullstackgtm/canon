"use client";

import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";

/** App and backend deploy independently, so new queries wait for the stable context API to advertise them. */
export function useOutboundAvailable() {
  return useQuery(api.organizations.context)?.features?.outbound === true;
}

export function useMailboxGrantsAvailable() {
  return useQuery(api.organizations.context)?.features?.mailboxGrants === true;
}
