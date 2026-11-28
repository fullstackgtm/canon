"use client"

import * as React from "react"
import { XIcon } from "lucide-react"
import * as DialogPrimitive from "@ui-sdk/react/dialog"

import { type UiProps, type AutoFocusProps, autoFocusTarget, asChildProps } from "@/components/ui/composition"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"

function Dialog({ ...props }: UiProps<typeof DialogPrimitive.Dialog>) {
  return <DialogPrimitive.Dialog {...props} />
}

function DialogTrigger({
  children,
  asChild,
  ...props
}: UiProps<typeof DialogPrimitive.DialogTrigger> & { asChild?: boolean }) {
  return <DialogPrimitive.DialogTrigger data-slot="dialog-trigger" {...asChildProps(asChild, children)}
      {...props} />
}

function DialogPortal({ children }: { children?: React.ReactNode }) {
  return <>{children}</>
}

function DialogClose({
  children,
  asChild,
  ...props
}: UiProps<typeof DialogPrimitive.DialogClose> & { asChild?: boolean }) {
  return <DialogPrimitive.DialogClose data-slot="dialog-close" {...asChildProps(asChild, children)}
      {...props} />
}

function DialogOverlay({
  className,
  ...props
}: UiProps<typeof DialogPrimitive.DialogBackdrop>) {
  return (
    <DialogPrimitive.DialogBackdrop
      data-slot="dialog-overlay"
      className={cn(
        "fixed inset-0 z-50 bg-black/50 transition-[opacity,transform,scale] duration-150 data-starting-style:opacity-0 data-ending-style:opacity-0 motion-reduce:transition-none",
        className
      )}
      {...props}
    />
  )
}

function DialogContent({
  onOpenAutoFocus,
  onCloseAutoFocus,
  onEscapeKeyDown,
  onKeyDownCapture,
  className,
  children,
  showCloseButton = true,
  ...props
}: UiProps<typeof DialogPrimitive.DialogContent> & AutoFocusProps & { onEscapeKeyDown?: (event: KeyboardEvent) => void } & {
  showCloseButton?: boolean
}) {
  return (
    <DialogPortal data-slot="dialog-portal">
      <DialogOverlay />
      <DialogPrimitive.DialogContent
        data-slot="dialog-content"
        finalFocus={autoFocusTarget(onCloseAutoFocus)}
        initialFocus={autoFocusTarget(onOpenAutoFocus)}
        onKeyDownCapture={(event) => {
          onKeyDownCapture?.(event)
          if (event.key === "Escape") onEscapeKeyDown?.(event.nativeEvent)
        }}
        className={cn(
          "bg-background m-0 fixed top-[50%] left-[50%] z-50 grid w-full max-w-[calc(100%-2rem)] translate-x-[-50%] translate-y-[-50%] gap-4 rounded-lg border p-6 shadow-lg outline-none sm:max-w-lg transition-[opacity,scale] duration-200 data-starting-style:scale-95 data-ending-style:scale-95 data-starting-style:opacity-0 data-ending-style:opacity-0 motion-reduce:transition-none",
          className
        )}
        {...props}
      >
        {children}
        {showCloseButton && (
          <DialogPrimitive.DialogClose
            data-slot="dialog-close"
            className="ring-offset-background focus:ring-ring data-open:bg-accent data-open:text-muted-foreground absolute top-4 right-4 rounded-xs opacity-70 transition-opacity hover:opacity-100 focus:ring-2 focus:ring-offset-2 focus:outline-hidden disabled:pointer-events-none [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4"
          >
            <XIcon />
            <span className="sr-only">Close</span>
          </DialogPrimitive.DialogClose>
        )}
      </DialogPrimitive.DialogContent>
    </DialogPortal>
  )
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-header"
      className={cn("flex flex-col gap-2 text-center sm:text-left", className)}
      {...props}
    />
  )
}

function DialogFooter({
  className,
  showCloseButton = false,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  showCloseButton?: boolean
}) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        "flex flex-col-reverse gap-2 sm:flex-row sm:justify-end",
        className
      )}
      {...props}
    >
      {children}
      {showCloseButton && (
        <DialogPrimitive.DialogClose render={<Button variant="outline" />}>Close</DialogPrimitive.DialogClose>
      )}
    </div>
  )
}

function DialogTitle({
  className,
  ...props
}: UiProps<typeof DialogPrimitive.DialogTitle>) {
  return (
    <DialogPrimitive.DialogTitle
      data-slot="dialog-title"
      className={cn("text-lg leading-none font-semibold", className)}
      {...props}
    />
  )
}

function DialogDescription({
  className,
  ...props
}: UiProps<typeof DialogPrimitive.DialogDescription>) {
  return (
    <DialogPrimitive.DialogDescription
      data-slot="dialog-description"
      className={cn("text-muted-foreground text-sm", className)}
      {...props}
    />
  )
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
}
