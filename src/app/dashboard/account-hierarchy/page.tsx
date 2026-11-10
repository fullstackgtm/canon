"use client";

import { ViewFrame } from "@/components/dashboard";
import { AccountHierarchyList } from "@/components/account-hierarchy/list-page";

export default function AccountHierarchyPage() {
  return (
    <ViewFrame title="Account hierarchy">
      <AccountHierarchyList />
    </ViewFrame>
  );
}
