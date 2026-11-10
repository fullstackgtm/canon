import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { reportsModuleTarget } from "./nav";

export function useReportsModuleHref(skip: boolean, path: "reports" | "dashboards" = "reports", query = ""): string | null | undefined {
  const modules = useQuery(api.modules.list, skip ? "skip" : {});
  if (skip || modules === undefined) return undefined;
  return reportsModuleTarget(modules, path, query);
}
