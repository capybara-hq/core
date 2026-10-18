"use client";

import {
  Button,
  KeyValue,
  PlaygroundPage,
  Stack,
  StatusMark,
  useStatusBar,
} from "@capybara-hq/design";
import { useParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useChat } from "../../../../../components/ChatView";
import { Composer } from "../../../../../components/Composer";
import { FormError } from "../../../../../components/form-error";
import { MessageList } from "../../../../../components/MessageList";
import { OrgGate } from "../../../../../components/OrgGate";

/** `/[locale]/chat/[conversationId]`：当前组织下的一个会话（PlaygroundPage）。 */
export default function ChatPage() {
  const { conversationId } = useParams<{ conversationId: string }>();
  return <OrgGate>{(orgId) => <Chat orgId={orgId} conversationId={conversationId} />}</OrgGate>;
}

function Chat({ orgId, conversationId }: { orgId: string; conversationId: string }) {
  const t = useTranslations();
  const chat = useChat(orgId, conversationId);
  const status = chat.running ? (
    <StatusMark status="running" label={t("chat.running")} />
  ) : (
    <StatusMark status="success" label={t("chat.idle")} />
  );
  useStatusBar(chat.running ? `· ${t("chat.running")}` : null);
  return (
    <PlaygroundPage
      header={{
        parent: { label: t("agents.title"), href: "/agents" },
        title: chat.agentName ?? t("chat.title"),
      }}
      inspectorTitle={t("chat.inspectorTitle")}
      inspector={
        <Stack gap={16}>
          <KeyValue
            keyWidth="10ch"
            rows={[
              { k: t("chat.agent"), v: chat.agentName ?? "—" },
              { k: t("chat.conversation"), v: conversationId },
              { k: t("chat.status"), v: status },
            ]}
          />
          {chat.running && (
            <Button onClick={chat.stop} disabled={chat.stopping}>
              {t("chat.stop")}
            </Button>
          )}
        </Stack>
      }
      composer={
        <Stack gap={8}>
          {chat.error !== undefined && <FormError message={chat.error} />}
          <Composer
            onSend={chat.send}
            stop={chat.running ? { onStop: chat.stop, stopping: chat.stopping } : undefined}
          />
        </Stack>
      }
    >
      <MessageList items={chat.items} reasoningOf={chat.reasoningOf} />
    </PlaygroundPage>
  );
}
