"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { ArrowLeft } from "lucide-react";
import { ViewFrame } from "@/components/dashboard";

/** A page of the workspace's own shape (pipelines, data model) under Customization: back to Customization, a title, what it is. */
export function RecipesSubpage({ title, description, children, compact = false }: { title: string; description: string; children: ReactNode; compact?: boolean }) {
  return (
    <ViewFrame
      title={title}
      compact={compact}
      description={description}
      controls={
        <Link href="/dashboard/customization" className="eyebrow inline-flex items-center gap-1.5 text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-3.5 w-3.5" /> Customization
        </Link>
      }
    >

      {children}
    </ViewFrame>
  );
}
