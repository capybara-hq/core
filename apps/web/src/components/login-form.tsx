"use client";

import { Button, Callout, Field, Input, Stack, Text } from "@capybara-hq/design";
import { useLocale, useTranslations } from "next-intl";
import { type FormEvent, useState } from "react";
import { type AuthSource, type LoginErrorCode, ssoStartUrl } from "../lib/auth-sources";
import { navigateBrowser } from "../lib/browser";
import { useAppMutation } from "../lib/query/mutation";
import { useSecureCookiesBlocked } from "../lib/secure-origin";
import { login } from "../lib/session";
import { useErrorMessage } from "../lib/use-error-message";
import { FormError } from "./form-error";

/**
 * The local sign-in form (inside the AuthPage card). On success it calls `onSuccess`, which ends
 * the cache's session and navigates (the page's call).
 */
export function LoginForm({ onSuccess }: { onSuccess: () => void }) {
  const t = useTranslations("login");
  const errorMessage = useErrorMessage();
  const [loginName, setLoginName] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  // A new session: the page drops the whole cache before it navigates, nothing to invalidate.
  const { mutateAsync: signIn } = useAppMutation({
    fn: (v: { login: string; password: string }) => login(v.login, v.password),
    invalidates: () => [],
  });

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPending(true);
    setError(undefined);
    try {
      await signIn({ login: loginName, password });
    } catch (err) {
      setError(errorMessage(err));
      setPending(false);
      return;
    }
    // Signed in: the caller loads a new document, so the button stays pending until it unloads.
    onSuccess();
  }

  return (
    // method="post": if the client JS did not load, the browser posts natively and the proxy signs
    // in server side (lib/form-post.ts); the password never travels in a URL.
    <form method="post" onSubmit={onSubmit}>
      <Stack gap={16}>
        <Field label={t("loginLabel")}>
          <Input
            name="login"
            autoComplete="username"
            required
            value={loginName}
            onChange={(e) => setLoginName(e.target.value)}
          />
        </Field>
        <Field label={t("passwordLabel")}>
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
        <Button type="submit" variant="primary" density="prominent" loading={pending}>
          {t("submit")}
        </Button>
      </Stack>
    </form>
  );
}

/**
 * Shown to everyone when the page is served over plain http from a non-localhost host, where the
 * browser drops Secure session cookies. One sentence for people; the operator's details (the
 * settings to change) live in the admin console and the docs. Renders nothing otherwise.
 */
export function InsecureOriginNotice() {
  const t = useTranslations("login");
  if (!useSecureCookiesBlocked()) return null;
  return <Callout tone="warn">{t("insecureOrigin")}</Callout>;
}

/** 第三方登录回跳带回的原因码 → 译文（只显示自己的文案，不回显身份源的任何文本）。 */
export function LoginErrorNotice({ code }: { code: LoginErrorCode }) {
  const t = useTranslations("login.ssoError");
  return <FormError message={t(code)} />;
}

/**
 * The third-party sign-in buttons for the sign-in sources (`GET /api/v1/auth/sources`, read by the
 * page from the cache); a click navigates the whole page to the kernel's start URL (with the return
 * page). Renders nothing without a source (or when they could not be read).
 */
export function SsoButtons({ returnTo, sources }: { returnTo: string; sources: AuthSource[] }) {
  const t = useTranslations("login");
  const locale = useLocale();
  if (sources.length === 0) return null;
  return (
    <Stack gap={8}>
      <Text variant="small" tone="muted">
        {t("or")}
      </Text>
      {sources.map((s) => (
        <Button
          key={s.plugin}
          density="prominent"
          onClick={() => navigateBrowser(ssoStartUrl(s.plugin, returnTo))}
        >
          {t("sso", { name: locale === "zh" ? s.label.zh : s.label.en })}
        </Button>
      ))}
    </Stack>
  );
}
