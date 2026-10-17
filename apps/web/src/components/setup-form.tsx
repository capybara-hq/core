"use client";

import { useTranslations } from "next-intl";
import { type FormEvent, type InputHTMLAttributes, useId, useState } from "react";
import { completeSetup, type SetupInput } from "../lib/session";
import { useErrorMessage } from "../lib/use-error-message";

/** 初始化向导表单：建首个企业管理员（可选同时建组织），成功后内核直接登录。 */
export function SetupForm({ onSuccess }: { onSuccess: () => void }) {
  const t = useTranslations("setup");
  const errorMessage = useErrorMessage();
  const id = useId();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const text = (name: string) => String(data.get(name) ?? "").trim();
    const input: SetupInput = {
      login: text("login"),
      password: String(data.get("password") ?? ""),
      displayName: text("displayName"),
    };
    if (text("orgName") !== "") input.orgName = text("orgName");
    if (text("setupToken") !== "") input.setupToken = text("setupToken");
    setPending(true);
    setError(undefined);
    try {
      await completeSetup(input);
      onSuccess();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(false);
    }
  }

  const field = (
    name: string,
    label: string,
    props: InputHTMLAttributes<HTMLInputElement> = {},
    hint?: string,
  ) => (
    <>
      <label htmlFor={`${id}-${name}`}>{label}</label>
      <input id={`${id}-${name}`} name={name} {...props} />
      {hint !== undefined && <small>{hint}</small>}
    </>
  );

  return (
    <form className="card" onSubmit={onSubmit}>
      <h1>{t("title")}</h1>
      <p>{t("intro")}</p>
      {field(
        "login",
        t("loginLabel"),
        { required: true, autoComplete: "username", minLength: 3, maxLength: 64 },
        t("loginHint"),
      )}
      {field(
        "password",
        t("passwordLabel"),
        {
          required: true,
          type: "password",
          autoComplete: "new-password",
          minLength: 12,
          maxLength: 256,
        },
        t("passwordHint"),
      )}
      {field("displayName", t("displayNameLabel"), { required: true, maxLength: 100 })}
      {field("orgName", t("orgNameLabel"), { maxLength: 100 })}
      {field("setupToken", t("setupTokenLabel"), { type: "password", autoComplete: "off" })}
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
