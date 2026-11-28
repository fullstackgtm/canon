"use client"

import * as React from "react"
import * as LabelPrimitive from "@ui-sdk/react/label"

import { type UiProps } from "@/components/ui/composition"

import { cn } from "@/lib/utils"

function Label({
  className,
  ...props
}: UiProps<typeof LabelPrimitive.Label>) {
  return (
    <LabelPrimitive.Label
      data-slot="label"
      className={cn(
        "flex items-center gap-2 text-sm leading-none font-medium select-none group-data-[disabled=true]:pointer-events-none group-data-[disabled=true]:opacity-50 peer-disabled:cursor-not-allowed peer-disabled:opacity-50",
        className
      )}
      {...props}
    />
  )
}

export { Label }
