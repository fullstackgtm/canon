"use client";

import { useOrganization, useOrganizationList } from "@clerk/nextjs";
import { useRouter } from "next/navigation";
import { Building2, Check, ChevronsUpDown } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";

/** Workspace switcher. Only rendered when Clerk is configured. */
export function OrgSwitcher({ collapsed }: { collapsed?: boolean }) {
  const { organization } = useOrganization();
  const { userMemberships, setActive } = useOrganizationList({
    userMemberships: { infinite: true },
  });
  const router = useRouter();
  const memberships = userMemberships?.data ?? [];

  const handleSwitch = async (orgId: string) => {
    if (orgId === organization?.id || !setActive) return;
    await setActive({ organization: orgId });
    router.push("/dashboard");
  };

  const label = organization?.name ?? "Select workspace";

  return (
    <div className="border-b border-sidebar-border px-2 py-2">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size={collapsed ? "icon" : "default"}
            title={collapsed ? label : undefined}
            className={cn(
              "text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-foreground",
              collapsed ? "size-8 w-full" : "h-9 w-full justify-between gap-2 px-2",
            )}
          >
            {collapsed ? (
              <Building2 className="size-4" />
            ) : (
              <>
                <span className="flex items-center gap-2 truncate">
                  <Building2 className="size-4 shrink-0" />
                  <span className="truncate text-sm">{label}</span>
                </span>
                <ChevronsUpDown className="size-3.5 shrink-0 opacity-50" />
              </>
            )}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side={collapsed ? "right" : "bottom"} align="start" className="w-56">
          {memberships.length === 0 && (
            <DropdownMenuItem disabled>No workspaces</DropdownMenuItem>
          )}
          {memberships.map((mem) => (
            <DropdownMenuItem
              key={mem.organization.id}
              onClick={() => handleSwitch(mem.organization.id)}
              className="flex items-center gap-2"
            >
              <span className="truncate">{mem.organization.name}</span>
              {mem.organization.id === organization?.id && (
                <Check className="ml-auto size-4 shrink-0" />
              )}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/** Static stand-in used when Clerk keys are absent (local dev). */
export function DevOrgSwitcher({ collapsed }: { collapsed?: boolean }) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 border-b border-sidebar-border px-4 py-3 text-sm text-sidebar-foreground/70",
        collapsed && "justify-center px-0",
      )}
      title="Dev Workspace"
    >
      <Building2 className="size-4 shrink-0" />
      {!collapsed && <span>Dev Workspace</span>}
    </div>
  );
}
