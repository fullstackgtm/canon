"use client"

import * as React from "react"
import * as TooltipPrimitive from "@ui-sdk/react/tooltip"

import { type UiProps, asChildProps } from "@/components/ui/composition"

import { cn } from "@/lib/utils"

const TooltipDelay = React.createContext(0)

function TooltipProvider({ delayDuration = 0, children }: { delayDuration?: number; children?: React.ReactNode }) {
  return <TooltipDelay.Provider value={delayDuration}>{children}</TooltipDelay.Provider>
}

function Tooltip({ delayDuration, ...props }: React.ComponentProps<typeof TooltipPrimitive.Tooltip> & { delayDuration?: number }) {
  const delay = React.useContext(TooltipDelay)
  return <TooltipPrimitive.Tooltip delay={delayDuration ?? delay} {...props} />
}

function TooltipTrigger({
  children,
  asChild,
  ...props
}: UiProps<typeof TooltipPrimitive.TooltipTrigger> & { asChild?: boolean }) {
  return <TooltipPrimitive.TooltipTrigger data-slot="tooltip-trigger" {...asChildProps(asChild, children)}
      {...props} />
}

function TooltipContent({
  className,
  sideOffset = 0,
  children,
  ...props
}: UiProps<typeof TooltipPrimitive.TooltipContent>) {
  return (
    <TooltipPrimitive.TooltipContent
      data-slot="tooltip-content"
      sideOffset={sideOffset}
      className={cn(
        "bg-foreground text-background z-50 w-fit origin-(--transform-origin) rounded-md px-3 py-1.5 text-xs text-balance transition-[opacity,transform,scale] duration-150 data-starting-style:opacity-0 data-ending-style:opacity-0 motion-reduce:transition-none data-starting-style:scale-95 data-ending-style:scale-95",
        className
      )}
      {...props}
    >
      {children}
      <TooltipPrimitive.TooltipArrow className="bg-foreground fill-foreground z-50 size-2.5 translate-y-[calc(-50%_-_2px)] rotate-45 rounded-[2px]" />
    </TooltipPrimitive.TooltipContent>
  )
}

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider }
