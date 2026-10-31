"use client";

import { cn } from "@/lib/utils";

/**
 * The lower-right home for floating launchers (background activity, and any
 * future tray). Children render left to right; hidden below `md`, where the
 * launchers would cover content. Ported from QuotaQueue.
 */
export function FloatingTrayDock({ className, children, ...props }: React.ComponentProps<"div">) {
  return (
    <div data-slot="floating-tray-dock" className={cn("fixed bottom-4 right-4 z-50 flex items-center gap-3 max-md:hidden", className)} {...props}>
      {children}
    </div>
  );
}

/** Round 48px launcher used by every tray in the dock. */
export const trayLauncherClassName =
  "relative flex size-12 items-center justify-center rounded-full border border-border bg-background text-foreground shadow-lg transition-transform hover:scale-105 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50";
