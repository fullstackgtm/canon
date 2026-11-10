"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { LoadingRows } from "@/components/dashboard";
import { fieldsHref } from "@/components/field-standards/shared";

/** Canon fields moved to their own page, above every CRM; old links follow them there. */
export default function SalesforceFieldsPage() {
  const router = useRouter();
  useEffect(() => router.replace(fieldsHref()), [router]);
  return <LoadingRows count={3} />;
}
