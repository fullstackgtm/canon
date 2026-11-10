"use client";

import { useAction } from "convex/react";
import { api } from "../../../convex/_generated/api";

/** `objects.writeScoped`, the one path every task edit takes, so history and receipts record it. */
export function useTaskWrite() {
  return useAction(api.objects.writeScoped);
}
