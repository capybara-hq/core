"use client";

import { ConnectBlock, Text, useToast } from "@capybara-hq/design";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { useRouter } from "../i18n/navigation";
import { isOAuthCodeConnector, useStartConnect } from "../lib/connect";
import { connectorQuery } from "../lib/query/conversation";
import type { ConnectItem } from "../lib/timeline";
import { useErrorMessage } from "../lib/use-error-message";

/** 个人连接页中某个连接器的位置（静态凭据在这里填写 token）。 */
export const connectionHref = (connectorId: string) =>
  `/account/connections#connector-${encodeURIComponent(connectorId)}`;

/**
 * The connect request (design `ConnectBlock`): the service, why, "only affects you" and Connect; once
 * the run ended only the explanation stays.
 * OAuth 连接器点「连接」直接发起授权（授权结束回到本页）；其余认证方式跳到个人连接页填写凭据。
 */
/**
 * Connects a connector for the viewer from where they are: an OAuth connector starts its
 * authorization (coming back to this page), any other goes to the personal connections page to
 * enter its credentials. `busy` names the connector whose connect is under way.
 */
export function useConnectConnector(orgId: string): {
  connect(connectorId: string): Promise<void>;
  busy: string | null;
} {
  const router = useRouter();
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const { start } = useStartConnect(orgId);
  const [busy, setBusy] = useState<string | null>(null);
  const qc = useQueryClient();

  async function connect(connectorId: string) {
    setBusy(connectorId);
    try {
      const app = await qc.fetchQuery(connectorQuery(orgId, connectorId));
      if (isOAuthCodeConnector(app.auth)) await start(connectorId);
      else router.push(connectionHref(connectorId));
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }
  return { connect, busy };
}

export function ConnectCard({ orgId, item }: { orgId: string; item: ConnectItem }) {
  const t = useTranslations("connect");
  const { connect, busy } = useConnectConnector(orgId);

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
          busy={busy === item.connectorId}
          onConnect={() => void connect(item.connectorId)}
        />
      )}
    </div>
  );
}
