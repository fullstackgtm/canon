"use client";

import { useMutation } from "convex/react";
import { api } from "../../../convex/_generated/api";

/** `objects.write`, the one path every task edit takes, so history and receipts record it. */
export function useTaskWrite() {
  return useMutation(api.objects.write);
}
