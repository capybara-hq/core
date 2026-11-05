"use client";

import { AuthPage, Stack } from "@capybara-hq/design";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import {
  InsecureOriginNotice,
  LoginErrorNotice,
  LoginForm,
  SsoButtons,
} from "../../../components/login-form";
import type { LoginErrorCode } from "../../../lib/auth-sources";
import { navigateBrowser } from "../../../lib/browser";
import { usePreferences } from "../../../lib/preferences";
import { authSourcesQuery } from "../../../lib/query/auth";
import { retryOnMountOf } from "../../../lib/query/client";
import { resetSession } from "../../../lib/query/workspace";
import { broadcastSession } from "../../../lib/session-sync";

/**
 * `/login`: local sign-in and the third-party sign-in buttons (AuthPage). `returnTo` (a safe site
 * path) is where a sign-in goes; `error` is a third-party sign-in's failure code. The sign-in
 * sources come from the cache (prefetched on a document load); failing to read them only hides the
 * third-party buttons. A sign-in tells the other tabs, drops the cache (nothing of a previous
 * session survives), then loads `returnTo` as a new document.
 */
export default function LoginView({
  returnTo,
  error,
}: {
  returnTo: string;
  error: LoginErrorCode | null;
}) {
  const t = useTranslations("login");
  const qc = useQueryClient();
  const preferences = usePreferences();
  const query = authSourcesQuery();
  const sources = useQuery({ ...query, retryOnMount: retryOnMountOf(query.queryKey) });
  if (sources.data === undefined && !sources.isError) {
    return (
      <AuthPage
        title={t("title")}
        subtitle={t("subtitle")}
        preferences={preferences}
        loading={{ fields: [{}, {}] }}
      />
    );
  }
  return (
    <AuthPage title={t("title")} subtitle={t("subtitle")} preferences={preferences}>
      <Stack gap={16}>
        <InsecureOriginNotice />
        {error !== null && <LoginErrorNotice code={error} />}
        <LoginForm
          onSuccess={() => {
            broadcastSession("signed-in");
            // A new session: drop the cache, then load returnTo as a new document (ruling R4).
            void resetSession(qc, () => navigateBrowser(returnTo));
          }}
        />
        <SsoButtons returnTo={returnTo} sources={sources.data ?? []} />
      </Stack>
    </AuthPage>
  );
}
