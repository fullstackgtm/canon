"use client";

import * as React from "react";
import { useState, useRef, useCallback, useEffect } from "react";
import { format, parse, isValid } from "date-fns";
import { DayPicker } from "react-day-picker";
import { CalendarIcon } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

/**
 * Parse a wide variety of typed date strings into a Date object.
 * Supports: 12312025, 12/31/2025, 12-31-2025, 1/1/25, etc.
 */
function parseTypedDate(input: string): Date | null {
  const cleaned = input.trim();
  if (!cleaned) return null;

  // Try digits-only: 12312025 → MM/DD/YYYY or 1312025 → M/DD/YYYY etc.
  const digitsOnly = cleaned.replace(/\D/g, "");
  if (digitsOnly.length >= 6 && digitsOnly === cleaned) {
    // 8 digits: MMDDYYYY
    if (digitsOnly.length === 8) {
      const m = parseInt(digitsOnly.slice(0, 2), 10);
      const d = parseInt(digitsOnly.slice(2, 4), 10);
      const y = parseInt(digitsOnly.slice(4, 8), 10);
      const date = new Date(y, m - 1, d);
      if (isValid(date) && date.getMonth() === m - 1 && date.getDate() === d) return date;
    }
    // 6 digits: MMDDYY
    if (digitsOnly.length === 6) {
      const m = parseInt(digitsOnly.slice(0, 2), 10);
      const d = parseInt(digitsOnly.slice(2, 4), 10);
      let y = parseInt(digitsOnly.slice(4, 6), 10);
      y = y >= 50 ? 1900 + y : 2000 + y;
      const date = new Date(y, m - 1, d);
      if (isValid(date) && date.getMonth() === m - 1 && date.getDate() === d) return date;
    }
    // 7 digits: could be MDDYYYY or MMDDYYY (unlikely), try MDDYYYY
    if (digitsOnly.length === 7) {
      const m = parseInt(digitsOnly.slice(0, 1), 10);
      const d = parseInt(digitsOnly.slice(1, 3), 10);
      const y = parseInt(digitsOnly.slice(3, 7), 10);
      const date = new Date(y, m - 1, d);
      if (isValid(date) && date.getMonth() === m - 1 && date.getDate() === d) return date;
    }
  }

  // Try common delimiter-based formats: M/D/YYYY, M-D-YYYY, M.D.YYYY
  const delimFormats = [
    "MM/dd/yyyy", "M/d/yyyy", "MM-dd-yyyy", "M-d-yyyy",
    "MM/dd/yy", "M/d/yy", "MM-dd-yy", "M-d-yy",
    "yyyy-MM-dd",
  ];
  for (const fmt of delimFormats) {
    const date = parse(cleaned, fmt, new Date());
    if (isValid(date)) return date;
  }

  return null;
}

/** Convert YYYY-MM-DD to display string MM/DD/YYYY */
function isoToDisplay(iso: string): string {
  if (!iso) return "";
  const date = parse(iso, "yyyy-MM-dd", new Date());
  if (!isValid(date)) return iso;
  return format(date, "MM/dd/yyyy");
}

/** Convert Date to ISO YYYY-MM-DD */
function dateToIso(date: Date): string {
  return format(date, "yyyy-MM-dd");
}

interface DateInputProps {
  /** ISO date string YYYY-MM-DD */
  value: string;
  onChange: (isoDate: string) => void;
  placeholder?: string;
  className?: string;
  min?: string;
}

export function DateInput({ value, onChange, placeholder = "MM/DD/YYYY", className, min }: DateInputProps) {
  const [text, setText] = useState(() => isoToDisplay(value));
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const prevValueRef = useRef(value);

  // Sync external value changes into text
  useEffect(() => {
    if (value !== prevValueRef.current) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- sync draft to external value
      setText(isoToDisplay(value));
      prevValueRef.current = value;
    }
  }, [value]);

  const commitText = useCallback((raw: string) => {
    if (!raw.trim()) {
      onChange("");
      return;
    }
    const parsed = parseTypedDate(raw);
    if (parsed) {
      const iso = dateToIso(parsed);
      onChange(iso);
      setText(isoToDisplay(iso));
      prevValueRef.current = iso;
    } else {
      // Revert to last valid value
      setText(isoToDisplay(value));
    }
  }, [onChange, value]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commitText(text);
      inputRef.current?.blur();
    }
    if (e.key === "Escape") {
      setText(isoToDisplay(value));
      inputRef.current?.blur();
    }
  };

  const handleCalendarSelect = (date: Date | undefined) => {
    if (date) {
      const iso = dateToIso(date);
      onChange(iso);
      setText(isoToDisplay(iso));
      prevValueRef.current = iso;
    }
    setOpen(false);
    // Refocus the text input after calendar selection
    setTimeout(() => inputRef.current?.focus(), 0);
  };

  const selectedDate = value ? parse(value, "yyyy-MM-dd", new Date()) : undefined;
  const minDate = min ? parse(min, "yyyy-MM-dd", new Date()) : undefined;

  return (
    <div className="relative flex items-center">
      <input
        ref={inputRef}
        type="text"
        inputMode="numeric"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => commitText(text)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        className={cn(
          "file:text-foreground placeholder:text-muted-foreground selection:bg-primary selection:text-primary-foreground [:root_&]:bg-input/30 border-input h-9 w-full min-w-0 rounded-md border bg-transparent px-3 py-1 pr-8 text-base shadow-xs transition-[color,box-shadow] outline-none disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
          "focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]",
          className,
        )}
      />
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="absolute right-1.5 flex size-6 items-center justify-center rounded text-muted-foreground hover:text-foreground transition-colors"
            tabIndex={-1}
          >
            <CalendarIcon className="size-3.5" />
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-3" align="end">
          <DayPicker
            mode="single"
            selected={selectedDate && isValid(selectedDate) ? selectedDate : undefined}
            onSelect={handleCalendarSelect}
            defaultMonth={selectedDate && isValid(selectedDate) ? selectedDate : new Date()}
            disabled={minDate ? { before: minDate } : undefined}
            classNames={{
              months: "flex flex-col sm:flex-row gap-2",
              month: "flex flex-col gap-4",
              month_caption: "flex justify-center pt-1 relative items-center text-sm font-medium",
              nav: "flex items-center gap-1",
              button_previous: "absolute left-1 size-7 bg-transparent p-0 opacity-50 hover:opacity-100 inline-flex items-center justify-center",
              button_next: "absolute right-1 size-7 bg-transparent p-0 opacity-50 hover:opacity-100 inline-flex items-center justify-center",
              month_grid: "w-full border-collapse",
              weekdays: "flex",
              weekday: "text-muted-foreground rounded-md w-8 font-normal text-[0.8rem]",
              week: "flex w-full mt-1",
              day: "size-8 text-center text-sm p-0 relative",
              day_button: "size-8 p-0 font-normal inline-flex items-center justify-center rounded-md hover:bg-accent hover:text-accent-foreground transition-colors",
              selected: "[&>button]:bg-primary [&>button]:text-primary-foreground [&>button]:hover:bg-primary [&>button]:hover:text-primary-foreground",
              today: "[&>button]:bg-accent [&>button]:text-accent-foreground",
              outside: "text-muted-foreground opacity-50",
              disabled: "text-muted-foreground opacity-50",
            }}
          />
        </PopoverContent>
      </Popover>
    </div>
  );
}
