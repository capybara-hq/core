"use client";

import { AuthPage, Stack } from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import {
  InsecureOriginNotice,
  LoginErrorNotice,
  LoginForm,
  SsoButtons,
} from "../../../components/login-form";
import { useRouter } from "../../../i18n/navigation";
import type { AuthSource, LoginErrorCode } from "../../../lib/auth-sources";
import { usePreferences } from "../../../lib/preferences";
import { broadcastSession } from "../../../lib/session-sync";

/**
 * `/login`: local sign-in and the third-party sign-in buttons (AuthPage). `returnTo` (a safe site
 * path) is where a sign-in goes; `error` is a third-party sign-in's failure code; `sources` the
 * sign-in sources. All of it comes from the server. A sign-in tells the other tabs first.
 */
export default function LoginView({
  returnTo,
  error,
  sources,
}: {
  returnTo: string;
  error: LoginErrorCode | null;
  sources: AuthSource[];
}) {
  const t = useTranslations("login");
  const router = useRouter();
  const preferences = usePreferences();
  return (
    <AuthPage title={t("title")} subtitle={t("subtitle")} preferences={preferences}>
      <Stack gap={16}>
        <InsecureOriginNotice />
        {error !== null && <LoginErrorNotice code={error} />}
        <LoginForm
          onSuccess={() => {
            broadcastSession("signed-in");
            router.replace(returnTo);
          }}
        />
        <SsoButtons returnTo={returnTo} sources={sources} />
      </Stack>
    </AuthPage>
  );
}
