"use client"

import * as React from "react"
import { CheckIcon } from "lucide-react"
import * as CheckboxPrimitive from "@ui-sdk/react/checkbox"

import { type UiProps } from "@/components/ui/composition"

import { cn } from "@/lib/utils"

function Checkbox({
  className,
  ...props
}: UiProps<typeof CheckboxPrimitive.Checkbox>) {
  return (
    <CheckboxPrimitive.Checkbox
      data-slot="checkbox"
      className={cn(
        "peer border-input [:root_&]:bg-input/30 data-checked:bg-primary data-checked:text-primary-foreground [:root_&]:data-checked:bg-primary data-checked:border-primary focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:ring-destructive/20 [:root_&]:aria-invalid:ring-destructive/40 aria-invalid:border-destructive size-4 shrink-0 rounded-[4px] border shadow-xs transition-shadow outline-none focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50",
        className
      )}
      {...props}
    >
      <CheckboxPrimitive.CheckboxIndicator
        data-slot="checkbox-indicator"
        className="grid place-content-center text-current transition-none"
      >
        <CheckIcon className="size-3.5" />
      </CheckboxPrimitive.CheckboxIndicator>
    </CheckboxPrimitive.Checkbox>
  )
}

export { Checkbox }
