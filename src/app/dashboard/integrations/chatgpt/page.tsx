"use client";

import { IntegrationPage } from "../integration-ui";
import { ChatgptConnect } from "../chatgpt-card";

export default function ChatgptIntegrationPage() {
  return (
    <IntegrationPage integration="chatgpt">
      <ChatgptConnect />
    </IntegrationPage>
  );
}
