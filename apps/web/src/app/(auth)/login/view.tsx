"use client";

import { AuthPage, Button, Stack } from "@capybara-hq/design";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { FormError } from "../../../components/form-error";
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
import { useAppMutation } from "../../../lib/query/mutation";
import { resetSession } from "../../../lib/query/workspace";
import { broadcastSession } from "../../../lib/session-sync";
import type { SignInCapabilityV1 } from "../../../lib/shell";
import { useSignInCapability } from "../../../lib/shell";

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
  // Inside the desktop shell (undefined on the server and before hydration: the form renders then).
  const browserSignIn = useSignInCapability();
  if (browserSignIn !== undefined) {
    return (
      <AuthPage title={t("title")} subtitle={t("subtitle")} preferences={preferences}>
        <BrowserSignIn
          capability={browserSignIn}
          error={error}
          onSuccess={() => {
            broadcastSession("signed-in");
            void resetSession(qc, () => navigateBrowser(returnTo));
          }}
        />
      </AuthPage>
    );
  }
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

/**
 * The desktop shell's only sign-in: the system browser (`signIn@1`). The click starts the call
 * (the shell enforces the user activation); `cancelled` leaves the page as it is, a failure shows
 * the generic sign-in error.
 */
function BrowserSignIn({
  capability,
  error,
  onSuccess,
}: {
  capability: SignInCapabilityV1;
  error: LoginErrorCode | null;
  onSuccess: () => void;
}) {
  const t = useTranslations("login");
  const [failed, setFailed] = useState(false);
  // A new session: the page drops the whole cache before it navigates, nothing to invalidate.
  const { mutateAsync: start, isPending } = useAppMutation({
    fn: () => capability.start(),
    invalidates: () => [],
  });
  async function onClick() {
    setFailed(false);
    let result: "signedIn" | "cancelled";
    try {
      result = await start();
    } catch {
      setFailed(true);
      return;
    }
    if (result === "signedIn") onSuccess();
  }
  return (
    <Stack gap={16}>
      {error !== null && <LoginErrorNotice code={error} />}
      {failed && <FormError message={t("ssoError.unknown")} />}
      <Button variant="primary" density="prominent" loading={isPending} onClick={onClick}>
        {t("browserSignIn")}
      </Button>
    </Stack>
  );
}
