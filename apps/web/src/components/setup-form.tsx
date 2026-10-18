"use client";

import { Button, Field, Input, Stack } from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { type FormEvent, useState } from "react";
import { completeSetup, type SetupInput } from "../lib/session";
import { useErrorMessage } from "../lib/use-error-message";
import { FormError } from "./form-error";

/** 初始化向导表单：建首个企业管理员（可选同时建组织），成功后内核直接登录。 */
export function SetupForm({ onSuccess }: { onSuccess: () => void }) {
  const t = useTranslations("setup");
  const errorMessage = useErrorMessage();
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

  return (
    <form onSubmit={onSubmit}>
      <Stack gap={16}>
        <Field label={t("loginLabel")} required help={t("loginHint")}>
          <Input name="login" required autoComplete="username" minLength={3} maxLength={64} />
        </Field>
        <Field label={t("passwordLabel")} required help={t("passwordHint")}>
          <Input
            name="password"
            type="password"
            required
            autoComplete="new-password"
            minLength={12}
            maxLength={256}
          />
        </Field>
        <Field label={t("displayNameLabel")} required>
          <Input name="displayName" required maxLength={100} />
        </Field>
        <Field label={t("orgNameLabel")} optional>
          <Input name="orgName" maxLength={100} />
        </Field>
        <Field label={t("setupTokenLabel")} optional help={t("setupTokenHint")}>
          <Input name="setupToken" type="password" autoComplete="off" />
        </Field>
        {error !== undefined && <FormError message={error} />}
        <Button type="submit" variant="primary" size={36} loading={pending}>
          {t("submit")}
        </Button>
      </Stack>
    </form>
  );
}
