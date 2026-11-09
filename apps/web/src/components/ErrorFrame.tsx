"use client";

import { Button, Stack, StatusPage } from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useTransition } from "react";
import { useRouter } from "../i18n/navigation";
import { withSafeUi } from "../lib/client-extensions";
import { useRoutePath } from "./shell/path";

/** The automatic retry: once, 3 s after the error, and not again within a minute. */
const AUTO_RETRY_MS = 3_000;
const AUTO_RETRY_WINDOW_MS = 60_000;
/**
 * When this tab last retried by itself. Module state on purpose: the error boundary mounts the
 * error page again after a failed retry, which must not retry forever.
 */
let lastAutoRetry = Number.NEGATIVE_INFINITY;

/**
 * The error boundaries' page (web-SSR spec §5, ruling R2): the maintenance status page with
 * 加载失败 and 重试. Next hides server error messages in production, so the page cannot tell one
 * failure from another: 重试 re-renders the route on the server (`router.refresh()`) and resets the
 * boundary in one transition, and the page does that once by itself after 3 s. The route-level
 * boundaries pass `safeReload`: 以安全模式重新加载 loads the current URL again as a document with
 * `safe-ui=1`, so no plugin interface code runs (client extensions spec §10.1).
 */
export function ErrorFrame({ reset, safeReload = false }: { reset(): void; safeReload?: boolean }) {
  const t = useTranslations("errors.page");
  const tc = useTranslations("clientExtensions");
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  // The page's own path (`<slug> / trajectories`), not `~`: the head says where the error is.
  const path = useRoutePath();
  const retry = useCallback(
    () =>
      startTransition(() => {
        router.refresh();
        reset();
      }),
    [router, reset],
  );
  useEffect(() => {
    if (Date.now() - lastAutoRetry < AUTO_RETRY_WINDOW_MS) return;
    const timer = setTimeout(() => {
      lastAutoRetry = Date.now();
      retry();
    }, AUTO_RETRY_MS);
    return () => clearTimeout(timer);
  }, [retry]);
  return (
    <StatusPage
      header={{ path, title: t("title") }}
      kind="maintenance"
      title={t("title")}
      description={t("description")}
      action={
        safeReload ? (
          <Stack direction="row" gap={8} justify="center" wrap>
            <Button variant="primary" loading={pending} onClick={retry}>
              {t("retry")}
            </Button>
            <Button
              onClick={() =>
                window.location.assign(
                  withSafeUi(`${location.pathname}${location.search}${location.hash}`),
                )
              }
            >
              {tc("safeReload")}
            </Button>
          </Stack>
        ) : (
          <Button variant="primary" loading={pending} onClick={retry}>
            {t("retry")}
          </Button>
        )
      }
    />
  );
}
