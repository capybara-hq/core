"use client";

import { AuthPage, Button, Stack, Text } from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { FormError } from "../../../../components/form-error";
import { SetupForm } from "../../../../components/setup-form";
import { useRouter } from "../../../../i18n/navigation";
import { getSetupStatus } from "../../../../lib/session";
import { useErrorMessage } from "../../../../lib/use-error-message";

type State =
  | { kind: "loading" }
  | { kind: "ready"; needsSetup: boolean }
  | { kind: "error"; message: string };

/** `/[locale]/setup`：初始化向导（AuthPage；`GET` / `POST /api/v1/setup`）。 */
export default function SetupPage() {
  const t = useTranslations();
  const errorMessage = useErrorMessage();
  const router = useRouter();
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    getSetupStatus()
      .then((s) => setState({ kind: "ready", needsSetup: s.needsSetup }))
      .catch((e: unknown) => setState({ kind: "error", message: errorMessage(e) }));
  }, [errorMessage]);

  let body: React.ReactNode;
  if (state.kind === "loading") body = <Text tone="muted">{t("common.loading")}</Text>;
  else if (state.kind === "error") body = <FormError message={state.message} />;
  else if (!state.needsSetup) {
    body = (
      <Stack gap={16}>
        <Text>{t("setup.alreadyDone")}</Text>
        <Button variant="primary" size={36} onClick={() => router.push("/login")}>
          {t("setup.goToLogin")}
        </Button>
      </Stack>
    );
  } else body = <SetupForm onSuccess={() => router.replace("/")} />;

  return (
    <AuthPage title={t("setup.title")} subtitle={t("setup.intro")}>
      {body}
    </AuthPage>
  );
}
