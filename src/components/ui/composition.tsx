import * as React from "react"

export type UiProps<C extends React.ElementType> = Omit<React.ComponentProps<C>, "className" | "children"> & {
  children?: React.ReactNode
  className?: string
}

export function asChildProps(asChild: boolean | undefined, children: React.ReactNode) {
  if (!asChild) return { children }
  const element = React.Children.only(children)
  if (!React.isValidElement<{ children?: React.ReactNode }>(element)) {
    throw new Error("asChild requires one React element")
  }
  return { render: element, children: element.props.children }
}

export type AutoFocusProps = {
  onOpenAutoFocus?: (event: Event) => void
  onCloseAutoFocus?: (event: Event) => void
}

export function autoFocusTarget(handler: ((event: Event) => void) | undefined) {
  if (!handler) return undefined
  return () => {
    const event = new Event("autofocus", { cancelable: true })
    handler(event)
    return event.defaultPrevented ? document.activeElement as HTMLElement | null : undefined
  }
}
