import type { ReactNode } from "react";

// Per-request CSP nonces require dynamic HTML.
export const dynamic = "force-dynamic";
export default function VisitLayout({ children }: { children: ReactNode }) { return children; }
