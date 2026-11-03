"use client";

import {
  AuthPage,
  Button,
  Card,
  type FieldShape,
  KeyValue,
  Stack,
  Text,
} from "@capybara-hq/design";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { FormError } from "../../../../components/form-error";
import { useRouter } from "../../../../i18n/navigation";
import { ApiClientError } from "../../../../lib/api";
import { loginPathFor } from "../../../../lib/auth-sources";
import { confirmBinding, type PendingBinding, splitSource } from "../../../../lib/identities";
import { usePreferences } from "../../../../lib/preferences";
import { pendingBindingQuery } from "../../../../lib/query/auth";
import { retryOnMountOf } from "../../../../lib/query/client";
import { useAppMutation } from "../../../../lib/query/define";
import { keys } from "../../../../lib/query/keys";
import { maybeMeQuery, meQuery } from "../../../../lib/query/shell";
import type { Me } from "../../../../lib/session";
import { useErrorMessage } from "../../../../lib/use-error-message";

/** No session or an expired one (apiFetch tried one refresh): sign in and come back here. */
const needsLogin = (e: unknown) => e instanceof ApiClientError && e.status === 401;

/** The link itself is unusable (unknown, expired or used). */
const invalidLink = (e: unknown) => e instanceof ApiClientError && e.code === "bind.invalid";

/** The confirm card while it loads: the display name, the identity's rows, the warning; Confirm. */
const LOADING_FIELDS: FieldShape[] = [
  { control: "text" },
  { control: "key-value", rows: 3, keyWidth: "10ch" },
  { control: "text" },
];

/**
 * `/bind/[token]`: confirm an IM identity binding (AuthPage). The bot's link in an IM direct
 * message points here; the pending binding comes from the cache the (auth) layout prefetched (a
 * signed-out visitor was sent to sign-in and back first).
 *
 * Against phishing: the IM display name, source (plugin) and tenant stand out, with the warning
 * "confirm only if you just started this in the IM yourself"; then the person confirms or cancels.
 */
export default function BindView({ token }: { token: string }) {
  const t = useTranslations("bind");
  const tc = useTranslations("common");
  const router = useRouter();
  const qc = useQueryClient();
  const errorMessage = useErrorMessage();
  const query = pendingBindingQuery(token);
  const pendingBinding = useQuery({ ...query, retryOnMount: retryOnMountOf(query.queryKey) });
  // The confirmed binding, or a confirm that found the link invalid meanwhile.
  const [done, setDone] = useState<PendingBinding>();
  const [invalid, setInvalid] = useState<unknown>();
  const [confirmError, setConfirmError] = useState<string>();
  const here = `/bind/${encodeURIComponent(token)}`;
  // The account's identities list gains the binding: invalidated under the cached session's
  // account (a page that lists them read the session first, so it is cached whenever they are).
  const confirm = useAppMutation({
    fn: () => confirmBinding(token),
    invalidates: () => {
      const me =
        qc.getQueryData<Me>(meQuery().queryKey) ??
        qc.getQueryData<Me | null>(maybeMeQuery().queryKey);
      return me ? [keys.account(me.account.id).identities()] : [];
    },
    onSuccess: (r) => setDone(r.binding),
  });

  async function onConfirm() {
    setConfirmError(undefined);
    try {
      await confirm.mutateAsync(undefined);
    } catch (e) {
      if (needsLogin(e)) router.replace(loginPathFor(here));
      else if (invalidLink(e)) setInvalid(e);
      else setConfirmError(errorMessage(e));
    }
  }

  const preferences = usePreferences();
  const failure = invalid ?? (pendingBinding.data === undefined ? pendingBinding.error : null);
  if (failure) {
    const gone = invalidLink(failure);
    return (
      <AuthPage title={gone ? t("invalidTitle") : t("title")} preferences={preferences}>
        <Stack gap={16}>
          <FormError message={errorMessage(failure)} />
          {gone ? (
            <Text variant="prose" tone="muted">
              {t("invalidHint")}
            </Text>
          ) : (
            <Button
              variant="primary"
              density="prominent"
              onClick={() => void pendingBinding.refetch()}
            >
              {tc("retry")}
            </Button>
          )}
          <Button density="prominent" onClick={() => router.replace("/")}>
            {t("goHome")}
          </Button>
        </Stack>
      </AuthPage>
    );
  }
  if (pendingBinding.data === undefined) {
    return (
      <AuthPage
        title={t("title")}
        subtitle={t("subtitle")}
        preferences={preferences}
        loading={{ fields: LOADING_FIELDS }}
      />
    );
  }
  const binding = done ?? pendingBinding.data;
  const pending = confirm.isPending;
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
  if (done !== undefined) {
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
            onClick={() => void onConfirm()}
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
