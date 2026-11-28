import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";

export function RecordSummary({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <summary className={`record-summary record-section-title ${className}`.trim()}>
    <ChevronRight aria-hidden className="record-chevron size-4 shrink-0" />
    <span className="min-w-0">{children}</span>
  </summary>;
}
