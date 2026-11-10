"use client";

import { useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import { LoadingRows } from "@/components/dashboard";
import { fieldsHref } from "@/components/field-standards/shared";

/** Canon fields moved to their own page, above every CRM; old links follow them there. */
export default function HubspotFieldPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  useEffect(() => router.replace(`${fieldsHref(id)}${window.location.search}`), [id, router]);
  return <LoadingRows count={4} />;
}
