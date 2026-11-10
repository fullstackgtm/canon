"use client";

import { ViewFrame } from "@/components/dashboard";
import { AccountHierarchyGroup } from "@/components/account-hierarchy/group-page";

export default function AccountHierarchyGroupPage() {
  return (
    <ViewFrame title="Account hierarchy">
      <AccountHierarchyGroup />
    </ViewFrame>
  );
}
