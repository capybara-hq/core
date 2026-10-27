"use client";

import { ConnectBlock, Text, useToast } from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { useRouter } from "../i18n/navigation";
import { isOAuthCodeConnector, useStartConnect } from "../lib/connect";
import { getConnector } from "../lib/connectors";
import type { ConnectItem } from "../lib/timeline";
import { useErrorMessage } from "../lib/use-error-message";

/** 个人连接页中某个连接器的位置（静态凭据在这里填写 token）。 */
export const connectionHref = (connectorId: string) =>
  `/settings/connections#connector-${encodeURIComponent(connectorId)}`;

/**
 * The connect request (design `ConnectBlock`): the service, why, "only affects you" and Connect; once
 * the run ended only the explanation stays.
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
      {item.closed ? (
        // The run ended: only the explanation stays, no Connect.
        <Text variant="small" tone="muted">
          {t("ended", { connector: item.connectorName })}
        </Text>
      ) : (
        <ConnectBlock
          service={item.connectorName}
          reason={t("description", { connector: item.connectorName })}
          busy={checking || starting}
          onConnect={() => void connect()}
        />
      )}
    </div>
  );
}
