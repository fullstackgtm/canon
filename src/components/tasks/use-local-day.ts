"use client";

import { useEffect, useState } from "react";
import { localDay } from "@/lib/my-tasks";

/** The viewer's local calendar day, rolled over at midnight while the tab stays open. */
export function useLocalDay(): string {
  const [day, setDay] = useState(() => localDay());
  useEffect(() => {
    const timer = setInterval(() => setDay(localDay()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return day;
}
