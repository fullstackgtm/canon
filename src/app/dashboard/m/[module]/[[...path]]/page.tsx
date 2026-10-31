"use client";

import { useParams } from "next/navigation";
import { ModulePage } from "@/components/modules/module-page";

/** Every installed module's pages: /dashboard/m/<module>/<page path> (docs/modules.md). */
export default function ModuleRoute() {
  const { module, path } = useParams<{ module: string; path?: string[] }>();
  return <ModulePage key={module} module={decodeURIComponent(module)} path={(path ?? []).map(decodeURIComponent)} />;
}
