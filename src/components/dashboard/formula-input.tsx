"use client";

import type {
  FocusEvent,
  InputHTMLAttributes,
  KeyboardEvent,
} from "react";
import { cn } from "@/lib/utils";
import {
  resolveSpreadsheetInputValue,
  type FormulaContext,
} from "@/lib/spreadsheet";

type FormulaInputProps = Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "onChange" | "onBlur" | "type" | "value"
> & {
  value: string | number;
  onValueChange: (value: string) => void;
  formulaContext?: FormulaContext;
  allowFormula?: boolean;
  onBlur?: (event: FocusEvent<HTMLInputElement>) => void;
};

export function FormulaInput({
  value,
  onValueChange,
  formulaContext = {},
  allowFormula = true,
  className,
  inputMode = "decimal",
  title,
  onBlur,
  onKeyDown,
  ...props
}: FormulaInputProps) {
  function commit(input: HTMLInputElement) {
    try {
      const nextValue = resolveSpreadsheetInputValue(
        input.value,
        formulaContext,
        allowFormula,
      );
      input.setCustomValidity("");
      input.value = nextValue;
      if (nextValue !== String(value)) onValueChange(nextValue);
      return true;
    } catch (error) {
      input.setCustomValidity(
        error instanceof Error ? error.message : "Invalid formula",
      );
      input.reportValidity();
      return false;
    }
  }

  function handleBlur(event: FocusEvent<HTMLInputElement>) {
    commit(event.currentTarget);
    onBlur?.(event);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      const committed = commit(event.currentTarget);
      if (committed) event.currentTarget.blur();
    }
    onKeyDown?.(event);
  }

  return (
    <input
      {...props}
      value={value}
      type="text"
      inputMode={inputMode}
      title={title ?? (allowFormula ? "Use = to enter formulas" : undefined)}
      onChange={(event) => {
        event.currentTarget.setCustomValidity("");
        onValueChange(event.currentTarget.value);
      }}
      onBlur={handleBlur}
      onKeyDown={handleKeyDown}
      className={cn(
        "rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-primary",
        className,
      )}
    />
  );
}
