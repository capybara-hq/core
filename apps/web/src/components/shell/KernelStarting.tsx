"use client";

import { Button, StatusPage } from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { useRouter } from "../../i18n/navigation";

/** How often the frame asks the server again, and for how long before it offers a manual retry. */
const RETRY_MS = 3_000;
const GIVE_UP_MS = 60_000;

/**
 * The `(app)` layout's frame while the kernel cannot answer (`getShell()` → `unavailable`, ruling
 * R2): the maintenance status page without the shell. It re-renders the route with
 * `router.refresh()` every 3 s for up to 60 s (the shell replaces it once the kernel answers),
 * then shows 重试, which starts the same round again.
 */
export function KernelStarting() {
  const t = useTranslations("errors.page");
  const router = useRouter();
  const [round, setRound] = useState(0);
  const [gaveUp, setGaveUp] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: round restarts the polling
  useEffect(() => {
    if (gaveUp) return;
    let elapsed = 0;
    const timer = setInterval(() => {
      elapsed += RETRY_MS;
      router.refresh();
      if (elapsed >= GIVE_UP_MS) {
        clearInterval(timer);
        setGaveUp(true);
      }
    }, RETRY_MS);
    return () => clearInterval(timer);
  }, [gaveUp, round, router]);
  const retry = () => {
    router.refresh();
    setGaveUp(false);
    setRound((r) => r + 1);
  };
  return (
    <StatusPage
      header={{ path: [{ label: "~" }], title: t("starting") }}
      kind="maintenance"
      title={t("starting")}
      description={gaveUp ? t("startingStill") : t("startingDescription")}
      {...(gaveUp
        ? {
            action: (
              <Button variant="primary" onClick={retry}>
                {t("retry")}
              </Button>
            ),
          }
        : {})}
    />
  );
}
