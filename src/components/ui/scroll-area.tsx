"use client"

import * as React from "react"
import * as ScrollAreaPrimitive from "@ui-sdk/react/scroll-area"

import { type UiProps } from "@/components/ui/composition"

import { cn } from "@/lib/utils"

function ScrollArea({
  className,
  children,
  ...props
}: UiProps<typeof ScrollAreaPrimitive.ScrollArea>) {
  return (
    <ScrollAreaPrimitive.ScrollArea
      data-slot="scroll-area"
      className={cn("relative", className)}
      {...props}
    >
      <ScrollAreaPrimitive.ScrollAreaViewport
        data-slot="scroll-area-viewport"
        className="focus-visible:ring-ring/50 size-full rounded-[inherit] transition-[color,box-shadow] outline-none focus-visible:ring-[3px] focus-visible:outline-1"
      >
        <ScrollAreaPrimitive.ScrollAreaContent>{children}</ScrollAreaPrimitive.ScrollAreaContent>
      </ScrollAreaPrimitive.ScrollAreaViewport>
      <ScrollBar />
      <ScrollAreaPrimitive.ScrollAreaCorner />
    </ScrollAreaPrimitive.ScrollArea>
  )
}

function ScrollBar({
  className,
  orientation = "vertical",
  ...props
}: UiProps<typeof ScrollAreaPrimitive.ScrollAreaScrollbar>) {
  return (
    <ScrollAreaPrimitive.ScrollAreaScrollbar
      data-slot="scroll-area-scrollbar"
      orientation={orientation}
      className={cn(
        "flex touch-none p-px opacity-0 transition-opacity select-none data-visible:opacity-100",
        orientation === "vertical" &&
          "h-full w-2.5 border-l border-l-transparent",
        orientation === "horizontal" &&
          "h-2.5 flex-col border-t border-t-transparent",
        className
      )}
      {...props}
    >
      <ScrollAreaPrimitive.ScrollAreaThumb
        data-slot="scroll-area-thumb"
        className="bg-border relative rounded-full"
      />
    </ScrollAreaPrimitive.ScrollAreaScrollbar>
  )
}

export { ScrollArea, ScrollBar }
