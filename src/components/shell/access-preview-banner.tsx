"use client";

import { useMutation, useQuery } from "convex/react";
import { Eye } from "lucide-react";
import { api } from "../../../convex/_generated/api";

/** While an admin previews a member (Settings, Permissions, "View as"), every page says so and offers the way out. */
export function AccessPreviewBanner() {
  const mine = useQuery(api.permissions.mine);
  const stop = useMutation(api.permissions.stopPreview);
  if (!mine?.preview) return null;
  return (
    <div role="status" className="sticky top-0 z-30 flex items-center gap-3 border-b border-amber-500/40 bg-amber-100 px-4 py-2 text-sm text-amber-950 dark:bg-amber-950 dark:text-amber-100">
      <Eye className="h-4 w-4" />
      <span>Viewing as <strong>{mine.preview.asName}</strong>. You see what they see; changes are off.</span>
      <button onClick={() => void stop({})} className="ml-auto border border-current px-2 py-0.5 text-xs font-medium">Exit preview</button>
    </div>
  );
}
