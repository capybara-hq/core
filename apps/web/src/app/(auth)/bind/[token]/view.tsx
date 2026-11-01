"use client";

import { AuthPage, Button, Card, KeyValue, Stack, Text } from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { FormError } from "../../../../components/form-error";
import { useRouter } from "../../../../i18n/navigation";
import { ApiClientError } from "../../../../lib/api";
import { loginPathFor } from "../../../../lib/auth-sources";
import { confirmBinding, type PendingBinding, splitSource } from "../../../../lib/identities";
import { usePreferences } from "../../../../lib/preferences";
import { useErrorMessage } from "../../../../lib/use-error-message";

/** What the server read: the pending binding, or the kernel's refusal (an error object does not
 * cross to the browser). */
export type BindInitial =
  | { kind: "ready"; binding: PendingBinding }
  | { kind: "error"; problem: { status: number; code: string; message: string } };

type State =
  | { kind: "ready"; binding: PendingBinding }
  | { kind: "done"; binding: PendingBinding }
  | { kind: "error"; error: unknown };

/** No session or an expired one (apiFetch tried one refresh): sign in and come back here. */
const needsLogin = (e: unknown) => e instanceof ApiClientError && e.status === 401;

/**
 * `/bind/[token]`: confirm an IM identity binding (AuthPage). The bot's link in an IM direct
 * message points here; the server read the pending binding (signed out, it sent the visitor to
 * sign-in and back).
 *
 * Against phishing: the IM display name, source (plugin) and tenant stand out, with the warning
 * "confirm only if you just started this in the IM yourself"; then the person confirms or cancels.
 */
export default function BindView({ token, initial }: { token: string; initial: BindInitial }) {
  const t = useTranslations("bind");
  const router = useRouter();
  const errorMessage = useErrorMessage();
  const [state, setState] = useState<State>(() =>
    initial.kind === "ready"
      ? initial
      : {
          kind: "error",
          error: new ApiClientError(
            initial.problem.status,
            initial.problem.code,
            initial.problem.message,
          ),
        },
  );
  const [pending, setPending] = useState(false);
  const [confirmError, setConfirmError] = useState<string>();
  const here = `/bind/${encodeURIComponent(token)}`;

  async function confirm(binding: PendingBinding) {
    setPending(true);
    setConfirmError(undefined);
    try {
      const r = await confirmBinding(token);
      setState({ kind: "done", binding: r.binding });
    } catch (e) {
      if (needsLogin(e)) router.replace(loginPathFor(here));
      else if (e instanceof ApiClientError && e.code === "bind.invalid")
        setState({ kind: "error", error: e });
      else {
        setConfirmError(errorMessage(e));
        setState({ kind: "ready", binding });
      }
    } finally {
      setPending(false);
    }
  }

  const preferences = usePreferences();
  if (state.kind === "error") {
    const invalid = state.error instanceof ApiClientError && state.error.code === "bind.invalid";
    return (
      <AuthPage title={invalid ? t("invalidTitle") : t("title")} preferences={preferences}>
        <Stack gap={16}>
          <FormError message={errorMessage(state.error)} />
          {invalid && <Text tone="muted">{t("invalidHint")}</Text>}
          <Button density="prominent" onClick={() => router.replace("/")}>
            {t("goHome")}
          </Button>
        </Stack>
      </AuthPage>
    );
  }
  const { binding } = state;
  const { plugin, tenant } = splitSource(binding.source);
  const identity = (
    <Stack gap={8}>
      <Text variant="h2">{binding.displayName}</Text>
      <KeyValue
        keyWidth="10ch"
        rows={[
          { k: t("source"), v: plugin },
          { k: t("tenant"), v: tenant === "" ? "—" : tenant },
          { k: t("externalId"), v: binding.externalId },
          ...(binding.email !== undefined ? [{ k: t("email"), v: binding.email }] : []),
        ]}
      />
    </Stack>
  );
  if (state.kind === "done") {
    return (
      <AuthPage title={t("doneTitle")} subtitle={t("doneHint")} preferences={preferences}>
        <Stack gap={16}>
          {identity}
          <Button variant="primary" density="prominent" onClick={() => router.replace("/")}>
            {t("goHome")}
          </Button>
        </Stack>
      </AuthPage>
    );
  }
  return (
    <AuthPage title={t("title")} subtitle={t("subtitle")} preferences={preferences}>
      <Stack gap={16}>
        {identity}
        <Card tone="danger">
          <div role="note">
            <Text tone="warn">{t("warning")}</Text>
          </div>
        </Card>
        {confirmError !== undefined && <FormError message={confirmError} />}
        <Stack gap={8}>
          <Button
            variant="primary"
            density="prominent"
            loading={pending}
            onClick={() => void confirm(binding)}
          >
            {t("confirm")}
          </Button>
          <Button density="prominent" disabled={pending} onClick={() => router.replace("/")}>
            {t("cancel")}
          </Button>
        </Stack>
      </Stack>
    </AuthPage>
  );
}
