"use client";

import { AuthPage, Button, KeyValue, Stack, versionLabel } from "@capybara-hq/design";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { FormError } from "../../../../components/form-error";
import { useRouter } from "../../../../i18n/navigation";
import { ApiClientError } from "../../../../lib/api";
import {
  type AuthorizeAppBody,
  appClientOf,
  authorizeApp,
  authorizeRequest,
} from "../../../../lib/app-auth";
import { loginPathFor } from "../../../../lib/auth-sources";
import { navigateBrowser } from "../../../../lib/browser";
import { usePreferences } from "../../../../lib/preferences";
import { platformMetaQuery } from "../../../../lib/query/app-auth";
import { retryOnMountOf } from "../../../../lib/query/client";
import { useAppMutation } from "../../../../lib/query/mutation";
import { maybeMeQuery } from "../../../../lib/query/shell";
import { useErrorMessage } from "../../../../lib/use-error-message";

type Query = Readonly<Record<string, string | undefined>>;

const needsLogin = (e: unknown) => e instanceof ApiClientError && e.status === 401;

/** The errors whose copy names the app that asked (`appAuth.clients.<client>.<key>`). */
const CLIENT_ERRORS: Readonly<Record<string, "redirectUriInvalid" | "codeInvalid">> = {
  "app_auth.redirect_uri_invalid": "redirectUriInvalid",
  "app_auth.code_invalid": "codeInvalid",
};

/**
 * `/apps/authorize`: the one confirmation before a Capybara app (`client`: the desktop app, desktop
 * client spec §6.5, or the mobile app, mobile spec §4.3) is signed in. The Sign in and Cancel
 * buttons post the kernel's authorize route (Cancel with `deny`); the page navigates only to the
 * redirect the kernel returned, never to the query's `redirect_uri`, and not at all when the
 * kernel refused. An unknown `client` is an invalid link.
 */
export default function AppAuthorizeView({ query }: { query: Query }) {
  const request = authorizeRequest(query);
  const t = useTranslations("appAuth");
  const preferences = usePreferences();
  if (request === null) {
    const client = appClientOf(query);
    return (
      <AuthPage title={t("invalidTitle")} preferences={preferences}>
        <FormError
          message={client === null ? t("invalidHint") : t(`clients.${client}.invalidHint`)}
        />
      </AuthPage>
    );
  }
  return <Consent request={request} />;
}

function Consent({ request }: { request: AuthorizeAppBody }) {
  const t = useTranslations("appAuth");
  const tc = useTranslations("common");
  const router = useRouter();
  const errorMessage = useErrorMessage();
  const preferences = usePreferences();
  const meQ = maybeMeQuery();
  const me = useQuery({ ...meQ, retryOnMount: retryOnMountOf(meQ.queryKey) });
  const metaQ = platformMetaQuery();
  const meta = useQuery({ ...metaQ, retryOnMount: retryOnMountOf(metaQ.queryKey) });
  const [returned, setReturned] = useState(false);
  const [error, setError] = useState<string>();
  const here = `/apps/authorize?${new URLSearchParams({
    client: request.client,
    redirect_uri: request.redirectUri,
    code_challenge: request.codeChallenge,
    code_challenge_method: request.codeChallengeMethod,
    state: request.state,
    name: request.name,
    app_version: request.appVersion,
  }).toString()}`;

  const send = useAppMutation({
    fn: (deny: boolean) => authorizeApp(deny ? { ...request, deny: true } : request),
    invalidates: () => [],
  });

  const signedOut = me.data === null;
  useEffect(() => {
    if (signedOut) router.replace(loginPathFor(here));
  }, [signedOut, router, here]);
  if (signedOut) return null;

  if (me.data === undefined || me.data === null) {
    if (me.error) {
      return (
        <AuthPage title={t("invalidTitle")} preferences={preferences}>
          <Stack gap={16}>
            <FormError message={errorMessage(me.error)} />
            <Button variant="primary" density="prominent" onClick={() => void me.refetch()}>
              {tc("retry")}
            </Button>
          </Stack>
        </AuthPage>
      );
    }
    return (
      <AuthPage
        title={t("invalidTitle")}
        preferences={preferences}
        loading={{ fields: [{ control: "key-value", rows: 3, keyWidth: "10ch" }], buttons: 2 }}
      />
    );
  }
  const account = me.data.account;

  if (returned) {
    return <AuthPage title={t("doneTitle")} subtitle={t("doneHint")} preferences={preferences} />;
  }

  const answer = async (deny: boolean) => {
    if (send.isPending) return;
    setError(undefined);
    try {
      const r = await send.mutateAsync(deny);
      setReturned(true);
      navigateBrowser(r.redirect);
    } catch (e) {
      if (needsLogin(e)) router.replace(loginPathFor(here));
      else {
        const key = e instanceof ApiClientError ? CLIENT_ERRORS[e.code] : undefined;
        setError(key === undefined ? errorMessage(e) : t(`clients.${request.client}.${key}`));
      }
    }
  };

  const platform = meta.data?.name ?? tc("appName");
  return (
    <AuthPage
      title={t(`clients.${request.client}.title`, { machine: request.name, platform })}
      subtitle={t(`clients.${request.client}.subtitle`)}
      preferences={preferences}
    >
      <Stack gap={16}>
        <KeyValue
          keyWidth="10ch"
          rows={[
            { k: t("account"), v: account.email ?? account.displayName },
            { k: t(`clients.${request.client}.machine`), v: request.name },
            { k: t("appVersion"), v: versionLabel(request.appVersion) },
          ]}
        />
        {error !== undefined && <FormError message={error} />}
        <Stack gap={8}>
          <Button
            variant="primary"
            density="prominent"
            loading={send.isPending && send.variables === false}
            disabled={send.isPending}
            onClick={() => void answer(false)}
          >
            {t("confirm")}
          </Button>
          <Button
            density="prominent"
            loading={send.isPending && send.variables === true}
            disabled={send.isPending}
            onClick={() => void answer(true)}
          >
            {t("cancel")}
          </Button>
        </Stack>
      </Stack>
    </AuthPage>
  );
}
