"use client";

import { Callout, useToast } from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { type ReactNode, useEffect, useState } from "react";
import { useErrorMessage } from "../../lib/use-error-message";
import { usePushRegistration } from "../../lib/use-push-registration";

const DISMISSED_KEY = "capybara.push.prompt.dismissed";

function readDismissed(): boolean {
  try {
    return window.localStorage.getItem(DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

function writeDismissed(): void {
  try {
    window.localStorage.setItem(DISMISSED_KEY, "1");
  } catch {
    // blocked: the prompt is hidden until the next load
  }
}

/**
 * The in-context push prompt (mobile app spec §9.3: ask when the person first has something
 * waiting, never at launch): a banner for the shell, or `null`. It shows when the shell offers
 * `push@1` with the permission still `prompt` and the pending count has become above zero in this
 * document; "Turn on" is the click that starts the OS prompt, "Not now" hides it for good (this profile's
 * `localStorage`, tolerant of blocked storage). Mounted once in the workspace frame.
 */
export function usePushPrompt(pendingCount: number): ReactNode {
  const t = useTranslations("notifications.prompt");
  const toast = useToast();
  const errorMessage = useErrorMessage();
  // the one instance that registers on every start (the settings page's own instance does not)
  const push = usePushRegistration({ autoRegister: true });
  const [waited, setWaited] = useState(false);
  // false on the server and in the first hydration; the stored answer after
  const [dismissed, setDismissed] = useState(true);
  useEffect(() => setDismissed(readDismissed()), []);
  useEffect(() => {
    if (pendingCount > 0) setWaited(true);
  }, [pendingCount]);
  if (push.state !== "prompt" || dismissed || !waited) return null;
  return (
    <Callout
      tone="info"
      actions={[
        {
          label: t("enable"),
          onSelect: () =>
            void push.enable().catch((e: unknown) => {
              // declining the OS prompt is an answer, not an error
              if ((e as { code?: unknown } | null)?.code !== "cancelled") {
                toast.error(errorMessage(e));
              }
            }),
        },
        {
          label: t("later"),
          onSelect: () => {
            writeDismissed();
            setDismissed(true);
          },
        },
      ]}
    >
      {t("text")}
    </Callout>
  );
}
