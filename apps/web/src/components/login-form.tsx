"use client";

import { Button, Field, Input, Stack, Text } from "@capybara-hq/design";
import { useLocale, useTranslations } from "next-intl";
import { type FormEvent, useEffect, useState } from "react";
import {
  type AuthSource,
  type LoginErrorCode,
  listAuthSources,
  ssoStartUrl,
} from "../lib/auth-sources";
import { navigateBrowser } from "../lib/browser";
import { secureCookiesBlocked } from "../lib/secure-origin";
import { login } from "../lib/session";
import { useErrorMessage } from "../lib/use-error-message";
import { FormError } from "./form-error";

/** 本地登录表单（放在 AuthPage 卡片内）。成功后调用 `onSuccess`（由页面负责跳转）。 */
export function LoginForm({ onSuccess }: { onSuccess: () => void }) {
  const t = useTranslations("login");
  const errorMessage = useErrorMessage();
  const [loginName, setLoginName] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPending(true);
    setError(undefined);
    try {
      await login(loginName, password);
      onSuccess();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit}>
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
        <Button type="submit" variant="primary" size={36} loading={pending}>
          {t("submit")}
        </Button>
      </Stack>
    </form>
  );
}

/** 第三方登录回跳带回的原因码 → 译文（只显示自己的文案，不回显身份源的任何文本）。 */
/**
 * Warns when the page is served over plain http from a non-localhost host: the browser drops the
 * Secure session cookies there, so sign-in silently fails. Renders nothing otherwise.
 */
export function InsecureOriginNotice() {
  const t = useTranslations("login");
  const [blocked, setBlocked] = useState(false);
  useEffect(() => {
    setBlocked(secureCookiesBlocked(window));
  }, []);
  if (!blocked) return null;
  return (
    <div role="status">
      <Text variant="small" tone="warn">
        {t("insecureOrigin")}
      </Text>
    </div>
  );
}

export function LoginErrorNotice({ code }: { code: LoginErrorCode }) {
  const t = useTranslations("login.ssoError");
  return <FormError message={t(code)} />;
}

/**
 * 第三方登录按钮：按 `GET /api/v1/auth/sources` 渲染，点击整页跳到内核的发起地址（带回跳页面）。
 * 没有可用的身份源（或读取失败）时不渲染任何东西。
 */
export function SsoButtons({ returnTo }: { returnTo: string }) {
  const t = useTranslations("login");
  const locale = useLocale();
  const [sources, setSources] = useState<AuthSource[]>([]);
  useEffect(() => {
    let disposed = false;
    listAuthSources().then(
      (r) => {
        if (!disposed) setSources(r.sources);
      },
      // 读取失败不影响本地登录
      () => {},
    );
    return () => {
      disposed = true;
    };
  }, []);
  if (sources.length === 0) return null;
  return (
    <Stack gap={8}>
      <Text variant="small" tone="muted">
        {t("or")}
      </Text>
      {sources.map((s) => (
        <Button
          key={s.plugin}
          size={36}
          onClick={() => navigateBrowser(ssoStartUrl(s.plugin, returnTo))}
        >
          {t("sso", { name: locale === "zh" ? s.label.zh : s.label.en })}
        </Button>
      ))}
    </Stack>
  );
}
