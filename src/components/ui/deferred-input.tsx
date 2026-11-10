"use client";

import { useState, useRef, useEffect } from "react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/**
 * Drop-in replacement for <Input> that buffers keystrokes locally
 * and only fires onChange on blur or Enter — prevents mutation spam.
 *
 * onChange receives the raw string value (not a ChangeEvent).
 * Escape reverts to the last committed value.
 */
interface DeferredInputProps extends Omit<React.ComponentProps<typeof Input>, "onChange" | "value"> {
  value: string | number | undefined;
  onChange: (value: string) => void;
}

function DeferredInput({ value, onChange, onKeyDown, ...props }: DeferredInputProps) {
  const [draft, setDraft] = useState(String(value ?? ""));
  const committedRef = useRef(value);

  useEffect(() => {
    if (value !== committedRef.current) {
      committedRef.current = value;
      // eslint-disable-next-line react-hooks/set-state-in-effect -- sync draft to external value
      setDraft(String(value ?? ""));
    }
  }, [value]);

  function commit() {
    if (draft !== String(committedRef.current ?? "")) {
      committedRef.current = draft;
      onChange(draft);
    }
  }

  return (
    <Input
      {...props}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") {
          setDraft(String(committedRef.current ?? ""));
          e.currentTarget.blur();
        }
        onKeyDown?.(e);
      }}
    />
  );
}

/**
 * Money input that displays dollars and commits value in cents.
 * User types "500" → onChange receives 50000 (cents).
 */
function DeferredMoneyInput({
  value,
  placeholder,
  onChange,
  className,
  dollarClassName = "text-sm",
}: {
  value: number | undefined;
  placeholder?: string;
  onChange: (cents: number | undefined) => void;
  className?: string;
  dollarClassName?: string;
}) {
  const [draft, setDraft] = useState(value ? (value / 100).toFixed(0) : "");
  const committedRef = useRef(value);

  useEffect(() => {
    if (value !== committedRef.current) {
      committedRef.current = value;
      // eslint-disable-next-line react-hooks/set-state-in-effect -- sync draft to external value
      setDraft(value ? (value / 100).toFixed(0) : "");
    }
  }, [value]);

  function commit() {
    const val = parseFloat(draft);
    const cents = val ? Math.round(val * 100) : undefined;
    if (cents !== committedRef.current) {
      committedRef.current = cents;
      onChange(cents);
    }
  }

  return (
    <div className="relative">
      <span className={cn("absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground", dollarClassName)}>
        $
      </span>
      <Input
        type="number"
        value={draft}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
        }}
        className={className}
      />
    </div>
  );
}

/**
 * Percentage input: user types "10" for 10%, stored as decimal 0.10.
 */
function DeferredPercentInput({
  value,
  placeholder,
  onChange,
  className,
}: {
  value: number | undefined;
  placeholder?: string;
  onChange: (decimal: number | undefined) => void;
  className?: string;
}) {
  const [draft, setDraft] = useState(value !== undefined ? (value * 100).toFixed(1).replace(/\.0$/, "") : "");
  const committedRef = useRef(value);

  useEffect(() => {
    if (value !== committedRef.current) {
      committedRef.current = value;
      // eslint-disable-next-line react-hooks/set-state-in-effect -- sync draft to external value
      setDraft(value !== undefined ? (value * 100).toFixed(1).replace(/\.0$/, "") : "");
    }
  }, [value]);

  function commit() {
    const val = parseFloat(draft);
    const decimal = !isNaN(val) ? val / 100 : undefined;
    if (decimal !== committedRef.current) {
      committedRef.current = decimal;
      onChange(decimal);
    }
  }

  return (
    <div className="relative">
      <Input
        type="number"
        step="0.1"
        value={draft}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
        }}
        className={cn("pr-6", className)}
      />
      <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
        %
      </span>
    </div>
  );
}

export { DeferredInput, DeferredMoneyInput, DeferredPercentInput };
