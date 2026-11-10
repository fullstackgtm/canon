"use client";

import { useEffect } from "react";
import { notFound, usePathname, useRouter, useSearchParams } from "next/navigation";
import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { LoadingRows } from "@/components/dashboard";
import { movedTo } from "./nav";

/**
 * A dashboard URL no Canon page serves: a page that moved into a module opens the module (docs/modules.md, "Places in
 * the nav"), with its query kept. Anything else is not found.
 */
export function MovedPage() {
  const pathname = usePathname();
  const search = useSearchParams().toString();
  const router = useRouter();
  const modules = useQuery(api.modules.list);
  const target = modules ? movedTo(pathname, modules) : undefined;
  useEffect(() => {
    if (target) router.replace(search ? `${target}?${search}` : target);
  }, [target, search, router]);
  if (target === null) notFound();
  return <LoadingRows />;
}
