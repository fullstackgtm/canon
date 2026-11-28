"use client";

import { Suspense } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { LoadingRows } from "@/components/dashboard";
import { ObjectListView } from "@/components/records/list-view";

import { RelatedRecordsPage } from "@/components/records/record-blocks";

function Records({ object }: { object: string }) {
  const params = useSearchParams();
  const sourceObject = params.get("relatedObject");
  const sourceId = params.get("relatedId");
  const relationship = params.get("relationship");
  if (sourceObject && sourceId && relationship) return <RelatedRecordsPage key={JSON.stringify([object, sourceObject, sourceId, relationship])} object={object} sourceObject={sourceObject} sourceId={sourceId} relationship={relationship} />;
  return <ObjectListView key={object} object={object} />;
}

export default function ObjectListPage() {
  const { object } = useParams<{ object: string }>();
  return (
    <Suspense fallback={<div className="p-4 sm:p-8"><LoadingRows /></div>}>
      <Records object={object} />
    </Suspense>
  );
}
