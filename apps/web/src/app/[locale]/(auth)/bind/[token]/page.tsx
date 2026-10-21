"use client";

import { AuthPage, Button, Card, KeyValue, Skeleton, Stack, Text } from "@capybara-hq/design";
import { useParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { FormError } from "../../../../../components/form-error";
import { LocaleLinks } from "../../../../../components/locale-links";
import { useRouter } from "../../../../../i18n/navigation";
import { ApiClientError } from "../../../../../lib/api";
import { loginPathFor } from "../../../../../lib/auth-sources";
import {
  confirmBinding,
  type PendingBinding,
  peekBinding,
  splitSource,
} from "../../../../../lib/identities";
import { useErrorMessage } from "../../../../../lib/use-error-message";

type State =
  | { kind: "loading" }
  | { kind: "ready"; binding: PendingBinding }
  | { kind: "done"; binding: PendingBinding }
  | { kind: "error"; error: unknown };

/** 会话缺失 / 失效（apiFetch 已试过一次 refresh）：去登录页并带回本页。 */
const needsLogin = (e: unknown) => e instanceof ApiClientError && e.status === 401;

/**
 * `/[locale]/bind/[token]`：IM 身份绑定确认（AuthPage）。机器人在 IM 私聊里发来的链接指向这里。
 *
 * 防钓鱼：醒目展示待绑定的 IM 显示名、来源（插件）与租户，并提示「只有刚刚亲自在 IM 里发起时才确认」，
 * 再由用户确认 / 取消。未登录先去登录页，登录后回到本页（`returnTo`）。
 */
export default function BindPage() {
  const t = useTranslations("bind");
  const { token } = useParams<{ token: string }>();
  const router = useRouter();
  const errorMessage = useErrorMessage();
  const [state, setState] = useState<State>({ kind: "loading" });
  const [pending, setPending] = useState(false);
  const [confirmError, setConfirmError] = useState<string>();
  const here = `/bind/${encodeURIComponent(token)}`;

  useEffect(() => {
    let disposed = false;
    peekBinding(token).then(
      (r) => {
        if (!disposed) setState({ kind: "ready", binding: r.binding });
      },
      (e: unknown) => {
        if (disposed) return;
        if (needsLogin(e)) router.replace(loginPathFor(here));
        else setState({ kind: "error", error: e });
      },
    );
    return () => {
      disposed = true;
    };
  }, [token, here, router]);

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

  const footer = <LocaleLinks />;
  if (state.kind === "loading") {
    return (
      <AuthPage title={t("title")} footer={footer}>
        <Stack gap={12}>
          <Text tone="muted">{t("loading")}</Text>
          <Skeleton rows={3} />
        </Stack>
      </AuthPage>
    );
  }
  if (state.kind === "error") {
    const invalid = state.error instanceof ApiClientError && state.error.code === "bind.invalid";
    return (
      <AuthPage title={invalid ? t("invalidTitle") : t("title")} footer={footer}>
        <Stack gap={16}>
          <FormError message={errorMessage(state.error)} />
          {invalid && <Text tone="muted">{t("invalidHint")}</Text>}
          <Button size={36} onClick={() => router.replace("/")}>
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
      <AuthPage title={t("doneTitle")} subtitle={t("doneHint")} footer={footer}>
        <Stack gap={16}>
          {identity}
          <Button variant="primary" size={36} onClick={() => router.replace("/")}>
            {t("goHome")}
          </Button>
        </Stack>
      </AuthPage>
    );
  }
  return (
    <AuthPage title={t("title")} subtitle={t("subtitle")} footer={footer}>
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
            size={36}
            loading={pending}
            onClick={() => void confirm(binding)}
          >
            {t("confirm")}
          </Button>
          <Button size={36} disabled={pending} onClick={() => router.replace("/")}>
            {t("cancel")}
          </Button>
        </Stack>
      </Stack>
    </AuthPage>
  );
}
