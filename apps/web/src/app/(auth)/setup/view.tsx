"use client";

import { AuthPage, Button, type FieldShape, Stack, Text } from "@capybara-hq/design";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useContext } from "react";
import { FormError } from "../../../components/form-error";
import { SetupForm } from "../../../components/setup-form";
import { useRouter } from "../../../i18n/navigation";
import { navigateBrowser } from "../../../lib/browser";
import { usePreferences } from "../../../lib/preferences";
import { setupStatusQuery } from "../../../lib/query/auth";
import { resetSession } from "../../../lib/query/workspace";
import { broadcastSession } from "../../../lib/session-sync";
import { useErrorMessage } from "../../../lib/use-error-message";
import { ServerSetupStatus } from "./status";

/** The setup form while it loads: login and password with their hints, two names, the token. */
const LOADING_FIELDS: FieldShape[] = [{ help: true }, { help: true }, {}, {}, { help: true }];

/**
 * `/setup`: the setup wizard (AuthPage; `GET` / `POST /api/v1/setup`). The layout already asked the
 * kernel on the server; only when it couldn't answer (starting, unreachable) the browser asks,
 * through the cache. Setting up signs the new admin in: the other tabs are told, the cache is
 * dropped, then home loads as a new document.
 */
export default function SetupView() {
  const initial = useContext(ServerSetupStatus);
  const t = useTranslations();
  const errorMessage = useErrorMessage();
  const router = useRouter();
  const qc = useQueryClient();
  const preferences = usePreferences();
  // Only when the kernel did not answer the layout's server read.
  const status = useQuery({ ...setupStatusQuery(), enabled: initial === undefined });
  const needsSetup = initial ?? status.data;

  let body: React.ReactNode;
  if (needsSetup === undefined) {
    if (!status.isError) {
      return (
        <AuthPage
          title={t("setup.title")}
          subtitle={t("setup.intro")}
          preferences={preferences}
          loading={{ fields: LOADING_FIELDS }}
        />
      );
    }
    body = (
      <Stack gap={16}>
        <FormError message={errorMessage(status.error)} />
        <Button variant="primary" density="prominent" onClick={() => void status.refetch()}>
          {t("common.retry")}
        </Button>
      </Stack>
    );
  } else if (!needsSetup) {
    body = (
      <Stack gap={16}>
        <Text>{t("setup.alreadyDone")}</Text>
        <Button variant="primary" density="prominent" onClick={() => router.push("/login")}>
          {t("setup.goToLogin")}
        </Button>
      </Stack>
    );
  } else {
    body = (
      <SetupForm
        onSuccess={() => {
          broadcastSession("signed-in");
          // A new session: drop the cache, then load the new document (ruling R4).
          void resetSession(qc, () => navigateBrowser("/"));
        }}
      />
    );
  }

  return (
    <AuthPage title={t("setup.title")} subtitle={t("setup.intro")} preferences={preferences}>
      {body}
    </AuthPage>
  );
}
