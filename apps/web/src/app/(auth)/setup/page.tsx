"use client";

import { AuthPage, Button, Stack, Text } from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { useContext, useEffect, useState } from "react";
import { FormError } from "../../../components/form-error";
import { SetupForm } from "../../../components/setup-form";
import { useRouter } from "../../../i18n/navigation";
import { usePreferences } from "../../../lib/preferences";
import { getSetupStatus } from "../../../lib/session";
import { useErrorMessage } from "../../../lib/use-error-message";
import { ServerSetupStatus } from "./status";

type State =
  | { kind: "loading" }
  | { kind: "ready"; needsSetup: boolean }
  | { kind: "error"; message: string };

/**
 * `/setup`: the setup wizard (AuthPage; `GET` / `POST /api/v1/setup`). The layout already asked the
 * kernel on the server; only when it couldn't answer (starting, unreachable) the browser asks.
 */
export default function SetupPage() {
  const initial = useContext(ServerSetupStatus);
  const t = useTranslations();
  const errorMessage = useErrorMessage();
  const router = useRouter();
  const preferences = usePreferences();
  const [state, setState] = useState<State>(
    initial === undefined ? { kind: "loading" } : { kind: "ready", needsSetup: initial },
  );

  useEffect(() => {
    if (initial !== undefined) return;
    getSetupStatus()
      .then((s) => setState({ kind: "ready", needsSetup: s.needsSetup }))
      .catch((e: unknown) => setState({ kind: "error", message: errorMessage(e) }));
  }, [initial, errorMessage]);

  let body: React.ReactNode;
  if (state.kind === "loading") body = <Text tone="muted">{t("common.loading")}</Text>;
  else if (state.kind === "error") body = <FormError message={state.message} />;
  else if (!state.needsSetup) {
    body = (
      <Stack gap={16}>
        <Text>{t("setup.alreadyDone")}</Text>
        <Button variant="primary" density="prominent" onClick={() => router.push("/login")}>
          {t("setup.goToLogin")}
        </Button>
      </Stack>
    );
  } else body = <SetupForm onSuccess={() => router.replace("/")} />;

  return (
    <AuthPage title={t("setup.title")} subtitle={t("setup.intro")} preferences={preferences}>
      {body}
    </AuthPage>
  );
}
