"use client";

import { AuthPage, Button, Field, Input, Stack } from "@capybara-hq/design";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { type FormEvent, useState } from "react";
import { FormError } from "../../../components/form-error";
import { navigateBrowser } from "../../../lib/browser";
import { usePreferences } from "../../../lib/preferences";
import { useAppMutation } from "../../../lib/query/mutation";
import { resetSession } from "../../../lib/query/workspace";
import { HOME_PATH } from "../../../lib/routes";
import { changePassword } from "../../../lib/session";
import { useErrorMessage } from "../../../lib/use-error-message";

/** The kernel's lower bound of a password (`validatePassword`). */
const MIN_LENGTH = 12;

/**
 * `/change-password` (AuthPage): the initial password, the new one twice. Saved, the cache is
 * dropped (the session read still says a change is due) and home loads as a new document.
 */
export default function ChangePasswordView() {
  const t = useTranslations("changePassword");
  const qc = useQueryClient();
  const preferences = usePreferences();
  const errorMessage = useErrorMessage();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  // the page loads a new document afterwards: nothing to invalidate
  const { mutateAsync } = useAppMutation({
    fn: (v: { current: string; next: string }) => changePassword(v.current, v.next),
    invalidates: () => [],
  });

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (next.length < MIN_LENGTH) return setError(t("tooShort"));
    if (next !== again) return setError(t("mismatch"));
    setPending(true);
    setError(undefined);
    try {
      await mutateAsync({ current, next });
    } catch (err) {
      setError(errorMessage(err));
      setPending(false);
      return;
    }
    void resetSession(qc, () => navigateBrowser(HOME_PATH));
  }

  return (
    <AuthPage title={t("title")} subtitle={t("subtitle")} preferences={preferences}>
      <form onSubmit={onSubmit}>
        <Stack gap={16}>
          <Field label={t("current")}>
            <Input
              name="current-password"
              type="password"
              autoComplete="current-password"
              required
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
            />
          </Field>
          <Field label={t("next")}>
            <Input
              name="new-password"
              type="password"
              autoComplete="new-password"
              required
              value={next}
              onChange={(e) => setNext(e.target.value)}
            />
          </Field>
          <Field label={t("confirm")}>
            <Input
              name="confirm-password"
              type="password"
              autoComplete="new-password"
              required
              value={again}
              onChange={(e) => setAgain(e.target.value)}
            />
          </Field>
          {error !== undefined && <FormError message={error} />}
          <Button type="submit" variant="primary" density="prominent" loading={pending}>
            {t("submit")}
          </Button>
        </Stack>
      </form>
    </AuthPage>
  );
}
