"use client";

import { Button, Field, Input, Stack } from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { type FormEvent, useState } from "react";
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
