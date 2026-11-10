"use client";

import { useParams } from "next/navigation";
import { RecordPage } from "@/components/records/record-page";

/** A company's one page, laid out by the workspace's account.page recipe. /dashboard/records/account/<id> redirects here. */
export default function AccountPage() {
  const { id } = useParams<{ id: string }>();
  return <RecordPage key={id} object="account" id={decodeURIComponent(id)} />;
}
