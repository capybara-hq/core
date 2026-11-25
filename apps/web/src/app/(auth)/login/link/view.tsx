"use client";

import {
  AuthPage,
  Avatar,
  Button,
  Field,
  type FieldShape,
  Input,
  KeyValue,
  Stack,
  Text,
} from "@capybara-hq/design";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { type FormEvent, useEffect, useState } from "react";
import { FormError } from "../../../../components/form-error";
import { useRouter } from "../../../../i18n/navigation";
import { ApiClientError } from "../../../../lib/api";
import { redeemLink, type SsoLinkView, safeReturnTo } from "../../../../lib/auth-sources";
import { navigateBrowser } from "../../../../lib/browser";
import { labelLocale } from "../../../../lib/extension-label";
import { usePreferences } from "../../../../lib/preferences";
import { ssoLinkQuery } from "../../../../lib/query/auth";
import { useAppMutation } from "../../../../lib/query/mutation";
import { resetSession } from "../../../../lib/query/workspace";
import { broadcastSession } from "../../../../lib/session-sync";
import { useErrorMessage } from "../../../../lib/use-error-message";

/** The codes that end the pending link: back to sign-in, which shows them. */
const ENDS_LINK = ["sso.link_expired", "sso.session_mismatch"] as const;
type EndCode = (typeof ENDS_LINK)[number];
const endCodeOf = (e: unknown): EndCode | null =>
  e instanceof ApiClientError && (ENDS_LINK as readonly string[]).includes(e.code)
    ? (e.code as EndCode)
    : null;

/** The identity, then the username and password. */
const LOADING_FIELDS: FieldShape[] = [
  { control: "text" },
  { control: "key-value", rows: 2, keyWidth: "10ch" },
  {},
  {},
];

/**
 * `/login/link` (AuthPage, login extensions spec §5): the external account the person just signed
 * in with (platform, display name, tenant, avatar) has no Capybara account that can sign in; the
 * person enters their username and password to link it. A success signs in exactly as a password
 * sign-in (the other tabs are told, the cache dropped, the returned path loaded as a new document,
 * where an account that must change its password is sent on). An unknown, expired or used ticket,
 * or one from another browser, goes back to sign-in with its code.
 */
export default function LinkView({ ticket }: { ticket: string }) {
  const t = useTranslations("login.link");
  const tl = useTranslations("login");
  const tc = useTranslations("common");
  const locale = labelLocale(useLocale());
  const router = useRouter();
  const qc = useQueryClient();
  const preferences = usePreferences();
  const errorMessage = useErrorMessage();
  const view = useQuery(ssoLinkQuery(ticket));
  const [loginName, setLoginName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string>();
  // A new session: the page drops the whole cache before it navigates, nothing to invalidate.
  const redeem = useAppMutation({
    fn: (v: { login: string; password: string }) => redeemLink({ ticket, ...v }),
    invalidates: () => [],
  });
  const ended = endCodeOf(view.error);

  useEffect(() => {
    if (ended !== null) router.replace(`/login?error=${ended}`);
  }, [ended, router]);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(undefined);
    let r: Awaited<ReturnType<typeof redeemLink>>;
    try {
      r = await redeem.mutateAsync({ login: loginName, password });
    } catch (err) {
      const end = endCodeOf(err);
      if (end !== null) {
        router.replace(`/login?error=${end}`);
        return;
      }
      setError(
        err instanceof ApiClientError && err.code === "identity.taken"
          ? t("taken", { platform: view.data?.label[locale] ?? "" })
          : errorMessage(err),
      );
      return;
    }
    broadcastSession("signed-in");
    // A new session: drop the cache, then load the page as a new document (ruling R4).
    void resetSession(qc, () => navigateBrowser(safeReturnTo(r.returnTo)));
  }

  if (view.data === undefined) {
    if (view.isError && ended === null) {
      return (
        <AuthPage title={t("title")} preferences={preferences}>
          <Stack gap={16}>
            <FormError message={errorMessage(view.error)} />
            <Button variant="primary" density="prominent" onClick={() => void view.refetch()}>
              {tc("retry")}
            </Button>
          </Stack>
        </AuthPage>
      );
    }
    return (
      <AuthPage
        title={t("title")}
        preferences={preferences}
        loading={{ fields: LOADING_FIELDS, subtitle: true, buttons: 2 }}
      />
    );
  }
  const link = view.data;
  const platform = link.label[locale];
  // a sign-in in flight, or done and loading the next document
  const busy = redeem.isPending || redeem.isSuccess;
  return (
    <AuthPage
      title={t("title")}
      subtitle={
        link.tenantId === ""
          ? t("introNoTenant", { platform, name: link.displayName })
          : t("intro", { platform, name: link.displayName, tenant: link.tenantId })
      }
      preferences={preferences}
    >
      <Stack gap={16}>
        <Identity link={link} platform={platform} />
        {link.linkedToAnother && (
          <Text variant="prose" tone="muted">
            {t("linkedToAnother")}
          </Text>
        )}
        {/* method="post": without the client JS the password never travels in a URL */}
        <form method="post" onSubmit={onSubmit}>
          <Stack gap={16}>
            <Field label={tl("loginLabel")}>
              <Input
                name="login"
                autoComplete="username"
                required
                value={loginName}
                onChange={(e) => setLoginName(e.target.value)}
              />
            </Field>
            <Field label={tl("passwordLabel")}>
              <Input
                name="password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </Field>
            {error !== undefined && <FormError message={error} />}
            <Stack gap={8}>
              <Button type="submit" variant="primary" density="prominent" loading={busy}>
                {t("submit")}
              </Button>
              <Button density="prominent" disabled={busy} onClick={() => router.replace("/login")}>
                {t("cancel")}
              </Button>
            </Stack>
          </Stack>
        </form>
        <Text variant="prose" tone="muted">
          {t("noAccount")}
        </Text>
      </Stack>
    </AuthPage>
  );
}

/** The external account: avatar and display name, then the platform and the tenant. */
function Identity({ link, platform }: { link: SsoLinkView; platform: string }) {
  const t = useTranslations("login.link");
  return (
    <Stack gap={8}>
      <Stack direction="row" gap={12} align="center">
        <Avatar
          shape="circle"
          size={40}
          name={link.displayName}
          value={link.avatarUrl !== undefined ? { kind: "image", src: link.avatarUrl } : null}
        />
        <Text variant="h2">{link.displayName}</Text>
      </Stack>
      <KeyValue
        keyWidth="10ch"
        rows={[
          { k: t("platform"), v: platform },
          { k: t("tenant"), v: link.tenantId === "" ? "—" : link.tenantId },
        ]}
      />
    </Stack>
  );
}
