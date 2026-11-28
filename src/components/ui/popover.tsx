"use client"

import * as React from "react"
import { renderElement, mergeProps } from "@ui-sdk/react/primitive"
import * as PopoverPrimitive from "@ui-sdk/react/popover"

import { type UiProps, type AutoFocusProps, autoFocusTarget, asChildProps } from "@/components/ui/composition"

import { cn } from "@/lib/utils"

const AnchorContext = React.createContext<{
  anchor: HTMLElement | null
  setAnchor: React.Dispatch<React.SetStateAction<HTMLElement | null>>
} | null>(null)

function Popover({ ...props }: UiProps<typeof PopoverPrimitive.Popover>) {
  const [anchor, setAnchor] = React.useState<HTMLElement | null>(null)
  return <AnchorContext.Provider value={{ anchor, setAnchor }}><PopoverPrimitive.Popover {...props} /></AnchorContext.Provider>
}

function PopoverTrigger({
  children,
  asChild,
  ...props
}: UiProps<typeof PopoverPrimitive.PopoverTrigger> & { asChild?: boolean }) {
  return <PopoverPrimitive.PopoverTrigger data-slot="popover-trigger" {...asChildProps(asChild, children)}
      {...props} />
}

function PopoverContent({
  onOpenAutoFocus,
  onCloseAutoFocus,
  className,
  align = "center",
  sideOffset = 4,
  ...props
}: UiProps<typeof PopoverPrimitive.PopoverContent> & AutoFocusProps) {
  const context = React.useContext(AnchorContext)
  return (
    <PopoverPrimitive.PopoverContent
      data-slot="popover-content"
      finalFocus={autoFocusTarget(onCloseAutoFocus)}
      initialFocus={autoFocusTarget(onOpenAutoFocus)}
      anchor={context?.anchor ?? undefined}
      align={align}
      sideOffset={sideOffset}
      className={cn(
        "bg-popover text-popover-foreground z-50 w-72 origin-(--transform-origin) rounded-md border p-4 shadow-md outline-hidden transition-[opacity,transform,scale] duration-150 data-starting-style:opacity-0 data-ending-style:opacity-0 motion-reduce:transition-none data-starting-style:scale-95 data-ending-style:scale-95",
        className
      )}
      {...props}
    />
  )
}

function PopoverAnchor({ asChild, children, ...props }: React.ComponentProps<"div"> & { asChild?: boolean }) {
  const context = React.useContext(AnchorContext)
  const { render, children: content } = asChildProps(asChild, children)
  return renderElement("div", mergeProps({ ref: context?.setAnchor }, { ...props, children: content }), render)
}

function PopoverHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="popover-header"
      className={cn("flex flex-col gap-1 text-sm", className)}
      {...props}
    />
  )
}

function PopoverTitle({ className, ...props }: React.ComponentProps<"h2">) {
  return (
    <div
      data-slot="popover-title"
      className={cn("font-medium", className)}
      {...props}
    />
  )
}

function PopoverDescription({
  className,
  ...props
}: React.ComponentProps<"p">) {
  return (
    <p
      data-slot="popover-description"
      className={cn("text-muted-foreground", className)}
      {...props}
    />
  )
}

export {
  Popover,
  PopoverTrigger,
  PopoverContent,
  PopoverAnchor,
  PopoverHeader,
  PopoverTitle,
  PopoverDescription,
}
