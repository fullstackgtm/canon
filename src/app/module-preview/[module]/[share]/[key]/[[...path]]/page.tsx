"use client";

import { useParams } from "next/navigation";
import { ConvexClientProvider } from "@/components/convex-provider";
import { ModuleSharePreview } from "@/components/modules/visitor-page";

export default function SharePreviewRoute() {
  const { module, share, key, path } = useParams<{ module: string; share: string; key: string; path?: string[] }>();
  return <ConvexClientProvider><ModuleSharePreview module={module} share={share} recordKey={key} path={path?.join("/")} /></ConvexClientProvider>;
}
