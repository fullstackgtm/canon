"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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

/**
 * Hover-to-open state for a dock tray. The popover opens from code, which by
 * default moves focus into it and, on close, back to the trigger. With
 * launchers that open on focus, that loop kept a tray open after the pointer
 * left and let one tray's close reopen another, so focus never moves here.
 * `onClose` runs when the pointer closes the tray; pass a stable callback.
 */
export function useHoverTray(onClose?: () => void) {
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelClose = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  }, []);
  const show = useCallback(() => {
    cancelClose();
    setOpen(true);
  }, [cancelClose]);
  const scheduleClose = useCallback(() => {
    cancelClose();
    // Time to cross the gap between the launcher and the portalled panel.
    timer.current = setTimeout(() => {
      setOpen(false);
      onClose?.();
    }, 150);
  }, [cancelClose, onClose]);
  useEffect(() => cancelClose, [cancelClose]);

  const keepFocus = (event: Event) => event.preventDefault();
  return {
    open,
    setOpen,
    triggerProps: { onMouseEnter: show, onMouseLeave: scheduleClose, onFocus: show },
    contentProps: { onMouseEnter: cancelClose, onMouseLeave: scheduleClose, onOpenAutoFocus: keepFocus, onCloseAutoFocus: keepFocus },
  };
}
