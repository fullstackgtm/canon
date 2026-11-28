"use client"

import * as React from "react"
import * as SeparatorPrimitive from "@ui-sdk/react/separator"

import { type UiProps } from "@/components/ui/composition"

import { cn } from "@/lib/utils"

function Separator({
  className,
  orientation = "horizontal",
  decorative = true,
  ...props
}: UiProps<typeof SeparatorPrimitive.Separator>) {
  return (
    <SeparatorPrimitive.Separator
      data-slot="separator"
      decorative={decorative}
      orientation={orientation}
      className={cn(
        "bg-border shrink-0 data-[orientation=horizontal]:h-px data-[orientation=horizontal]:w-full data-[orientation=vertical]:h-full data-[orientation=vertical]:w-px",
        className
      )}
      {...props}
    />
  )
}

export { Separator }
