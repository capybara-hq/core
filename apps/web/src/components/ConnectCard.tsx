"use client";

import { Button, Card, Stack, StatusMark, Text } from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { useRouter } from "../i18n/navigation";
import type { ChatItem } from "../lib/stream";

type ConnectItem = Extract<ChatItem, { kind: "connect" }>;

/** 个人连接页中某个应用的位置（第一段：填写 token；第二段接 OAuth）。 */
export const connectionHref = (appId: string) =>
  `/settings/connections#app-${encodeURIComponent(appId)}`;

/**
 * 需要连接卡片：应用名与「连接」按钮（跳到个人连接页填写凭据）；所在运行已结束时只显示说明。
 */
export function ConnectCard({ item }: { item: ConnectItem }) {
  const t = useTranslations("connect");
  const router = useRouter();
  return (
    <div data-role="connect" data-app-id={item.appId}>
      <Card
        title={t("title")}
        actions={item.closed ? undefined : <StatusMark status="waiting" label={t("status")} />}
      >
        {item.closed ? (
          // 运行已结束：只留说明，不再提供进行中的「连接」操作
          <Text tone="muted">{t("ended", { app: item.appName })}</Text>
        ) : (
          <Stack gap={12}>
            <Text>{t("description", { app: item.appName })}</Text>
            <Stack direction="row" gap={8}>
              {/* 对话里唯一的主操作是输入框的「发送」 */}
              <Button onClick={() => router.push(connectionHref(item.appId))}>{t("action")}</Button>
            </Stack>
          </Stack>
        )}
      </Card>
    </div>
  );
}
