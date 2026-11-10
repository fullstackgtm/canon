"use client";

import { useParams } from "next/navigation";
import { RecordPage } from "@/components/records/record-page";

export default function ObjectRecordPage() {
  const { object, id } = useParams<{ object: string; id: string }>();
  return <RecordPage key={id} object={object} id={decodeURIComponent(id)} />;
}
