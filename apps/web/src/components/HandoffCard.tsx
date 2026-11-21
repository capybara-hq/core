"use client";

import { Button, Card, LinkButton, Text } from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { useStartConnect } from "../lib/connect";
import type { HandoffTarget } from "../lib/conversations";

/**
 * A `Platform` operation's link card (platform web parity spec §4.4, §6): the decision waits for
 * the person on a web page, so the card names it with one button. `link` opens the page (a
 * relative path, never another host); `connect` starts the connector's OAuth flow from this
 * session and goes to the authorization page, coming back to this conversation.
 */
export function HandoffCard({
  orgId,
  title,
  target,
}: {
  orgId: string;
  title: string;
  target: HandoffTarget;
}) {
  const t = useTranslations("chat.handoff");
  const { start, starting } = useStartConnect(orgId);
  const action =
    target.type === "link" ? (
      <LinkButton href={target.url} variant="primary" density="dense">
        {t("open")}
      </LinkButton>
    ) : (
      <Button
        variant="primary"
        density="dense"
        loading={starting}
        disabled={starting}
        onClick={() => void start(target.connectorId)}
      >
        {t("connect")}
      </Button>
    );
  return (
    <Card title={title} tone="accent" actions={action}>
      <Text variant="small" tone="muted">
        {target.type === "link" ? t("linkBody") : t("connectBody")}
      </Text>
    </Card>
  );
}
