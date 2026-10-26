"use client";

import { Button, PlaygroundPage, Stack, StatusMark, useStatusBar } from "@capybara-hq/design";
import { useParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { useChat } from "../../../../../components/ChatView";
import { Composer } from "../../../../../components/Composer";
import { ChatPanel } from "../../../../../components/chat-panel/ChatPanel";
import { FormError } from "../../../../../components/form-error";
import { MessageList } from "../../../../../components/MessageList";
import { OrgGate } from "../../../../../components/OrgGate";

/** `/[locale]/chat/[conversationId]`：当前组织下的一个会话（PlaygroundPage）。 */
export default function ChatPage() {
  const { conversationId } = useParams<{ conversationId: string }>();
  return (
    <OrgGate>{(orgId) => <ChatInOrg orgId={orgId} conversationId={conversationId} />}</OrgGate>
  );
}

/**
 * 会话属于打开它时的当前组织：切换组织后（AppFrame 正在跳回列表）不再以新组织 + 旧会话渲染 Chat，
 * 免得用新组织去读旧会话。
 */
function ChatInOrg({ orgId, conversationId }: { orgId: string; conversationId: string }) {
  const [openedIn] = useState(orgId);
  if (orgId !== openedIn) return null;
  return <Chat orgId={orgId} conversationId={conversationId} />;
}

function Chat({ orgId, conversationId }: { orgId: string; conversationId: string }) {
  const t = useTranslations();
  const chat = useChat(orgId, conversationId);
  const status = chat.running ? (
    <StatusMark status="running" label={t("chat.running")} />
  ) : chat.waiting ? (
    <StatusMark status="waiting" label={t("chat.waiting")} />
  ) : (
    <StatusMark status="success" label={t("chat.idle")} />
  );
  useStatusBar(
    chat.running ? `· ${t("chat.running")}` : chat.waiting ? `· ${t("chat.waiting")}` : null,
  );
  // 等人处理时也可以停止（中止运行，未处理的审批 / 输入按拒绝处理）
  const active = chat.running || chat.waiting;
  return (
    <PlaygroundPage
      header={{
        breadcrumb: [{ label: t("agents.title"), href: "/agents" }],
        title: chat.agentName ?? t("chat.title"),
      }}
      inspectorTitle={t("chat.inspectorTitle")}
      inspector={
        <ChatPanel
          orgId={orgId}
          conversationId={conversationId}
          chat={chat}
          header={
            <Stack direction="row" gap={8} align="center" justify="between">
              {status}
              {active && (
                <Button onClick={chat.stop} disabled={chat.stopping}>
                  {t("chat.stop")}
                </Button>
              )}
            </Stack>
          }
        />
      }
      composer={
        <Stack gap={8}>
          {chat.error !== undefined && <FormError message={chat.error} />}
          <Composer
            orgId={orgId}
            onSend={chat.send}
            stop={active ? { onStop: chat.stop, stopping: chat.stopping } : undefined}
          />
        </Stack>
      }
    >
      <MessageList orgId={orgId} items={chat.items} reasoningOf={chat.reasoningOf} />
    </PlaygroundPage>
  );
}
