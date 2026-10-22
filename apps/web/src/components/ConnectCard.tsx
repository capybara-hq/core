"use client";

import { Button, Card, Stack, StatusMark, Text, useToast } from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { useRouter } from "../i18n/navigation";
import { isOAuthCodeConnector, useStartConnect } from "../lib/connect";
import { getConnector } from "../lib/connectors";
import type { ChatItem } from "../lib/stream";
import { useErrorMessage } from "../lib/use-error-message";

type ConnectItem = Extract<ChatItem, { kind: "connect" }>;

/** 个人连接页中某个连接器的位置（静态凭据在这里填写 token）。 */
export const connectionHref = (connectorId: string) =>
  `/settings/connections#connector-${encodeURIComponent(connectorId)}`;

/**
 * 需要连接卡片：连接器名与「连接」按钮；所在运行已结束时只显示说明。
 * OAuth 连接器点「连接」直接发起授权（授权结束回到本页）；其余认证方式跳到个人连接页填写凭据。
 */
export function ConnectCard({ orgId, item }: { orgId: string; item: ConnectItem }) {
  const t = useTranslations("connect");
  const router = useRouter();
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const { start, starting } = useStartConnect(orgId);
  const [checking, setChecking] = useState(false);

  async function connect() {
    setChecking(true);
    try {
      const { connector: app } = await getConnector(orgId, item.connectorId);
      if (isOAuthCodeConnector(app.auth)) await start(item.connectorId);
      else router.push(connectionHref(item.connectorId));
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setChecking(false);
    }
  }

  return (
    <div data-role="connect" data-connector-id={item.connectorId}>
      <Card
        title={t("title")}
        tone={item.closed ? "default" : "accent"}
        actions={item.closed ? undefined : <StatusMark status="waiting" label={t("status")} />}
      >
        {item.closed ? (
          // 运行已结束：只留说明，不再提供进行中的「连接」操作
          <Text tone="muted">{t("ended", { connector: item.connectorName })}</Text>
        ) : (
          <Stack gap={12}>
            <Text>{t("description", { connector: item.connectorName })}</Text>
            <Stack direction="row" gap={8}>
              {/* 对话里唯一的主操作是输入框的「发送」 */}
              <Button loading={checking || starting} onClick={() => void connect()}>
                {t("action")}
              </Button>
            </Stack>
          </Stack>
        )}
      </Card>
    </div>
  );
}
