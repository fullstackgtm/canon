"use client";

import { useParams } from "next/navigation";
import { ConversationPage } from "@/components/crm/conversations";

export default function ConversationRoute() {
  const { id } = useParams<{ id: string }>();
  return <ConversationPage key={id} conversationId={decodeURIComponent(id)} />;
}
