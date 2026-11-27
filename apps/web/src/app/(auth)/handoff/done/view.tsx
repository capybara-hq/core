"use client";

import { AuthPage, LinkButton, Stack, Text } from "@capybara-hq/design";
import { useQuery } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { FormError } from "../../../../components/form-error";
import { navigateBrowser } from "../../../../lib/browser";
import { labelLocale } from "../../../../lib/extension-label";
import {
  appDeepLink,
  type HandoffDone,
  handoffResultParams,
  parseHandoffDone,
} from "../../../../lib/handoff";
import { usePreferences } from "../../../../lib/preferences";
import { platformMetaQuery } from "../../../../lib/query/app-auth";
import { authSourcesQuery } from "../../../../lib/query/auth";
import { retryOnMountOf } from "../../../../lib/query/client";
import { connectorQuery } from "../../../../lib/query/conversation";
import { maybeMeQuery } from "../../../../lib/query/shell";

/** The deep links this document already tried on its own: each at most once (a remount too). */
const tried = new Set<string>();

const noSubscribe = () => () => {};

/** This page's origin in the browser; null in the server render (and while hydrating). */
function useOrigin(): string | null {
  return useSyncExternalStore(
    noSubscribe,
    () => window.location.origin,
    () => null,
  );
}

/**
 * The connector's name when this browser's session can read it, else undefined (signed out, not a
 * member any more, or not a connector result): the page then says it generically.
 */
function useConnectorName(done: HandoffDone | null): string | undefined {
  const me = useQuery(maybeMeQuery()).data;
  const orgId = done?.kind === "connector" ? done.orgId : "";
  const connectorId = done?.kind === "connector" ? done.connectorId : "";
  const query = connectorQuery(orgId, connectorId);
  const connector = useQuery({
    ...query,
    enabled: orgId !== "" && connectorId !== "" && me !== undefined && me !== null,
    retry: false,
    retryOnMount: retryOnMountOf(query.queryKey),
  });
  return connector.data?.name;
}

/** The login method's display name from the sign-in sources, else its plugin key. */
function useSourceName(done: HandoffDone | null): string | undefined {
  const locale = labelLocale(useLocale());
  const plugin = done?.kind === "identity-link" ? done.plugin : undefined;
  const query = authSourcesQuery();
  const sources = useQuery({
    ...query,
    enabled: plugin !== undefined,
    retryOnMount: retryOnMountOf(query.queryKey),
  });
  if (plugin === undefined) return undefined;
  return sources.data?.find((s) => s.plugin === plugin)?.label[locale] ?? plugin;
}

/**
 * `/handoff/done` (AuthPage; shell external authorization spec §3): the result of a browser
 * handoff's flow in words, with the connector's or login method's name where readable, and the
 * error's translation. The way back into the app is `<scheme>://open?url=<this origin + returnTo +
 * result>`, offered only when the platform lists the scheme (`appSchemes`) and `returnTo` is a safe
 * site path, and tried once on its own; otherwise the page only says to go back to the app.
 */
export default function HandoffDoneView({ search }: { search: string }) {
  const t = useTranslations("handoff.done");
  const tConnect = useTranslations("connect.result");
  const tIdentities = useTranslations("identities");
  const preferences = usePreferences();
  const done = useMemo(() => parseHandoffDone(search), [search]);
  const metaQ = platformMetaQuery();
  const meta = useQuery({ ...metaQ, retryOnMount: retryOnMountOf(metaQ.queryKey) }).data;
  const origin = useOrigin();
  const connectorName = useConnectorName(done);
  const sourceName = useSourceName(done);

  const deepLink =
    done !== null && done.returnTo !== undefined && origin !== null && meta !== undefined
      ? appDeepLink(done.scheme, meta.appSchemes, origin, done.returnTo, handoffResultParams(done))
      : null;

  useEffect(() => {
    if (deepLink === null || tried.has(deepLink)) return;
    tried.add(deepLink);
    navigateBrowser(deepLink);
  }, [deepLink]);

  const back =
    deepLink === null ? (
      <Text variant="prose" tone="muted">
        {t("backToApp")}
      </Text>
    ) : (
      <Stack gap={8}>
        <LinkButton variant="primary" density="prominent" href={deepLink}>
          {t("back")}
        </LinkButton>
        <Text variant="prose" tone="muted">
          {t("closeTabHint")}
        </Text>
      </Stack>
    );

  if (done === null) {
    return (
      <AuthPage title={t("unknownTitle")} preferences={preferences}>
        {back}
      </AuthPage>
    );
  }
  if (done.result.kind === "ok") {
    const title =
      done.kind === "connector"
        ? connectorName === undefined
          ? t("connectedGeneric")
          : t("connected", { name: connectorName })
        : sourceName === undefined
          ? t("linkedGeneric")
          : t("linked", { name: sourceName });
    return (
      <AuthPage title={title} preferences={preferences}>
        {back}
      </AuthPage>
    );
  }
  const { code } = done.result;
  const message =
    done.kind === "connector"
      ? tConnect.has(`error.${code}`)
        ? tConnect(`error.${code}`)
        : tConnect("unknown")
      : tIdentities.has(`linkError.${code}`)
        ? tIdentities(`linkError.${code}`)
        : tIdentities("linkError.unknown");
  return (
    <AuthPage title={t("failed")} preferences={preferences}>
      <Stack gap={16}>
        <FormError message={message} />
        {back}
      </Stack>
    </AuthPage>
  );
}
