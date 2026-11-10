"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useNav } from "@/components/shell/use-nav-sections";

/** The dashboard opens on the workspace's landing page (workspace.nav). */
export default function DashboardIndex() {
  const { home } = useNav();
  const router = useRouter();
  useEffect(() => {
    if (home) router.replace(home);
  }, [home, router]);
  return null;
}
