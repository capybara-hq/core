"use client";

import { Button, Field, Input, Stack } from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { type FormEvent, useState } from "react";
import { ApiClientError } from "../lib/api";
import { useAppMutation } from "../lib/query/mutation";
import { completeSetup, type SetupInput } from "../lib/session";
import { useErrorMessage } from "../lib/use-error-message";
import { FormError } from "./form-error";

/**
 * The setup wizard's form: creates the first super admin (and optionally an org); on success
 * the kernel signs them in and `onSuccess` (the page) ends the cache's session and navigates.
 * `initialError` is the error code of a native setup POST that failed (lib/form-post.ts).
 */
export function SetupForm({
  onSuccess,
  initialError,
}: {
  onSuccess: () => void;
  initialError?: string | undefined;
}) {
  const t = useTranslations("setup");
  const errorMessage = useErrorMessage();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>(() =>
    initialError === undefined
      ? undefined
      : errorMessage(new ApiClientError(400, initialError, initialError)),
  );
  // A new session: the page drops the whole cache before it navigates, nothing to invalidate.
  const { mutateAsync: setUp } = useAppMutation({ fn: completeSetup, invalidates: () => [] });

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
      await setUp(input);
    } catch (err) {
      setError(errorMessage(err));
      setPending(false);
      return;
    }
    // Signed in: the caller loads a new document, so the button stays pending until it unloads.
    onSuccess();
  }

  return (
    // method="post": without the client JS the proxy completes the setup (lib/form-post.ts).
    <form method="post" onSubmit={onSubmit}>
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
        <Button type="submit" variant="primary" density="prominent" loading={pending}>
          {t("submit")}
        </Button>
      </Stack>
    </form>
  );
}
