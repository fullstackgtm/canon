"use client";

import { Suspense } from "react";
import { useParams } from "next/navigation";
import { LoadingRows } from "@/components/dashboard";
import { ObjectListView } from "@/components/records/list-view";

export default function ObjectListPage() {
  const { object } = useParams<{ object: string }>();
  return (
    <Suspense fallback={<div className="p-4 sm:p-8"><LoadingRows /></div>}>
      <ObjectListView key={object} object={object} />
    </Suspense>
  );
}
