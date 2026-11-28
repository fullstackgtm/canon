"use client";

import type { ComponentProps } from "react";
import { DropdownMenuItem } from "./dropdown-menu";

export function RecordActionControl({ menu, children, disabled, onClick, ...props }: Omit<ComponentProps<"button">, "onClick"> & {
  menu?: boolean; onClick: () => void;
}) {
  return menu
    ? <DropdownMenuItem disabled={disabled} onSelect={onClick}>{children}</DropdownMenuItem>
    : <button {...props} type="button" disabled={disabled} onClick={onClick}>{children}</button>;
}
