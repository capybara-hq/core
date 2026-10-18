"use client";

import { useParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { ChatView } from "../../../../../components/ChatView";
import { OrgGate } from "../../../../../components/OrgGate";
import { Link } from "../../../../../i18n/navigation";

/** `/[locale]/chat/[conversationId]`：当前组织下的一个会话。 */
export default function ChatPage() {
  const t = useTranslations();
  const { conversationId } = useParams<{ conversationId: string }>();
  return (
    <OrgGate>
      {(orgId) => (
        <div className="card wide">
          <div className="row">
            <h1>{t("chat.title")}</h1>
            <Link href="/agents">{t("agents.backToList")}</Link>
          </div>
          <ChatView orgId={orgId} conversationId={conversationId} />
        </div>
      )}
    </OrgGate>
  );
}
