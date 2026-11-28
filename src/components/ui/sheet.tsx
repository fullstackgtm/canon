"use client"

import * as React from "react"
import { XIcon } from "lucide-react"
import * as SheetPrimitive from "@ui-sdk/react/dialog"

import { type UiProps, type AutoFocusProps, autoFocusTarget, asChildProps } from "@/components/ui/composition"

import { cn } from "@/lib/utils"

function Sheet({ ...props }: UiProps<typeof SheetPrimitive.Dialog>) {
  return <SheetPrimitive.Dialog {...props} />
}

function SheetTrigger({
  children,
  asChild,
  ...props
}: UiProps<typeof SheetPrimitive.DialogTrigger> & { asChild?: boolean }) {
  return <SheetPrimitive.DialogTrigger data-slot="sheet-trigger" {...asChildProps(asChild, children)}
      {...props} />
}

function SheetClose({
  children,
  asChild,
  ...props
}: UiProps<typeof SheetPrimitive.DialogClose> & { asChild?: boolean }) {
  return <SheetPrimitive.DialogClose data-slot="sheet-close" {...asChildProps(asChild, children)}
      {...props} />
}

function SheetPortal({ children }: { children?: React.ReactNode }) {
  return <>{children}</>
}

function SheetOverlay({
  className,
  ...props
}: UiProps<typeof SheetPrimitive.DialogBackdrop>) {
  return (
    <SheetPrimitive.DialogBackdrop
      data-slot="sheet-overlay"
      className={cn(
        "fixed inset-0 z-50 bg-black/50 transition-[opacity,transform,scale] duration-150 data-starting-style:opacity-0 data-ending-style:opacity-0 motion-reduce:transition-none",
        className
      )}
      {...props}
    />
  )
}

function SheetContent({
  onOpenAutoFocus,
  onCloseAutoFocus,
  onEscapeKeyDown,
  onKeyDownCapture,
  className,
  children,
  side = "right",
  showCloseButton = true,
  ...props
}: UiProps<typeof SheetPrimitive.DialogContent> & AutoFocusProps & { onEscapeKeyDown?: (event: KeyboardEvent) => void } & {
  side?: "top" | "right" | "bottom" | "left"
  showCloseButton?: boolean
}) {
  return (
    <SheetPortal>
      <SheetOverlay />
      <SheetPrimitive.DialogContent
        data-slot="sheet-content"
        finalFocus={autoFocusTarget(onCloseAutoFocus)}
        initialFocus={autoFocusTarget(onOpenAutoFocus)}
        onKeyDownCapture={(event) => {
          onKeyDownCapture?.(event)
          if (event.key === "Escape") onEscapeKeyDown?.(event.nativeEvent)
        }}
        className={cn(
          "bg-background fixed m-0 max-h-none max-w-none z-50 flex flex-col gap-4 shadow-lg transition-[opacity,translate] ease-in-out data-closed:duration-300 data-open:duration-500 data-starting-style:opacity-0 data-ending-style:opacity-0 motion-reduce:transition-none",
          side === "right" &&
            "inset-y-0 right-0 left-auto data-starting-style:translate-x-full data-ending-style:translate-x-full h-full w-3/4 border-l sm:max-w-sm",
          side === "left" &&
            "inset-y-0 left-0 right-auto data-starting-style:-translate-x-full data-ending-style:-translate-x-full h-full w-3/4 border-r sm:max-w-sm",
          side === "top" &&
            "inset-x-0 top-0 bottom-auto data-starting-style:-translate-y-full data-ending-style:-translate-y-full h-auto border-b",
          side === "bottom" &&
            "inset-x-0 bottom-0 top-auto data-starting-style:translate-y-full data-ending-style:translate-y-full h-auto border-t",
          className
        )}
        {...props}
      >
        {children}
        {showCloseButton && (
          <SheetPrimitive.DialogClose className="ring-offset-background focus:ring-ring data-open:bg-secondary absolute top-4 right-4 rounded-xs opacity-70 transition-opacity hover:opacity-100 focus:ring-2 focus:ring-offset-2 focus:outline-hidden disabled:pointer-events-none">
            <XIcon className="size-4" />
            <span className="sr-only">Close</span>
          </SheetPrimitive.DialogClose>
        )}
      </SheetPrimitive.DialogContent>
    </SheetPortal>
  )
}

function SheetHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sheet-header"
      className={cn("flex flex-col gap-1.5 p-4", className)}
      {...props}
    />
  )
}

function SheetFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sheet-footer"
      className={cn("mt-auto flex flex-col gap-2 p-4", className)}
      {...props}
    />
  )
}

function SheetTitle({
  className,
  ...props
}: UiProps<typeof SheetPrimitive.DialogTitle>) {
  return (
    <SheetPrimitive.DialogTitle
      data-slot="sheet-title"
      className={cn("text-foreground font-semibold", className)}
      {...props}
    />
  )
}

function SheetDescription({
  className,
  ...props
}: UiProps<typeof SheetPrimitive.DialogDescription>) {
  return (
    <SheetPrimitive.DialogDescription
      data-slot="sheet-description"
      className={cn("text-muted-foreground text-sm", className)}
      {...props}
    />
  )
}

export {
  Sheet,
  SheetTrigger,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetFooter,
  SheetTitle,
  SheetDescription,
}
