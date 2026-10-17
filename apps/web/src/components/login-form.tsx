"use client";

import { useTranslations } from "next-intl";
import { type FormEvent, useId, useState } from "react";
import { login } from "../lib/session";
import { useErrorMessage } from "../lib/use-error-message";

/** 本地登录表单。成功后调用 `onSuccess`（由页面负责跳转）。 */
export function LoginForm({ onSuccess }: { onSuccess: () => void }) {
  const t = useTranslations("login");
  const errorMessage = useErrorMessage();
  const id = useId();
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
    <form className="card" onSubmit={onSubmit}>
      <h1>{t("title")}</h1>
      <label htmlFor={`${id}-login`}>{t("loginLabel")}</label>
      <input
        id={`${id}-login`}
        name="login"
        autoComplete="username"
        required
        value={loginName}
        onChange={(e) => setLoginName(e.target.value)}
      />
      <label htmlFor={`${id}-password`}>{t("passwordLabel")}</label>
      <input
        id={`${id}-password`}
        name="password"
        type="password"
        autoComplete="current-password"
        required
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />
      {error !== undefined && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <button type="submit" disabled={pending}>
        {pending ? t("submitting") : t("submit")}
      </button>
    </form>
  );
}
