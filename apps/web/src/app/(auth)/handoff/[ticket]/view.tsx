"use client";

import { AuthPage, Button, Stack, Text } from "@capybara-hq/design";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { FormError } from "../../../../components/form-error";
import { ApiClientError } from "../../../../lib/api";
import { loginPathFor } from "../../../../lib/auth-sources";
import { navigateBrowser } from "../../../../lib/browser";
import { isHandoffLocation, redeemHandoff } from "../../../../lib/handoff";
import { usePreferences } from "../../../../lib/preferences";
import { useAppMutation } from "../../../../lib/query/mutation";
import { markSigningOut, resetSession } from "../../../../lib/query/workspace";
import { logout } from "../../../../lib/session";
import { broadcastSession } from "../../../../lib/session-sync";
import { useErrorMessage } from "../../../../lib/use-error-message";

/**
 * The redeem of each ticket this document started. A ticket is single use: a second POST would
 * answer `handoff.invalid` to a person whose first redeem succeeded, so every mount of the page
 * (React's development double effect, a remount) awaits the same request.
 */
const redeems = new Map<string, Promise<{ location: string }>>();

/** No session or an expired one (apiFetch tried one refresh): sign in and come back here. */
const needsLogin = (e: unknown) => e instanceof ApiClientError && e.status === 401;

const codeOf = (e: unknown) => (e instanceof ApiClientError ? e.code : undefined);

/** The ticket's account as the mismatch names it: its email, else its display name. */
function ownerOf(e: unknown): string {
  const d = (e instanceof ApiClientError ? e.rawDetails[0] : undefined) as
    | { displayName?: unknown; email?: unknown }
    | undefined;
  if (typeof d?.email === "string" && d.email !== "") return d.email;
  return typeof d?.displayName === "string" ? d.displayName : "";
}

/** The kernel answered a location the page refuses to open (not http(s), not a site path). */
const BAD_LOCATION = new Error("handoff location refused");

/**
 * `/handoff/[ticket]` (AuthPage; shell external authorization spec §2): a native shell opened this
 * page in the system browser. On mount the ticket is redeemed once in this signed-in browser, and
 * the browser goes on to the address the kernel answers (the provider's authorize page) when it is
 * http(s) or a site path. An unknown, used or expired ticket shows the invalid state; a ticket of
 * another account names that account and offers to sign in with another one (the ticket is spent
 * either way, so the copy also says to start again in the app).
 */
export default function HandoffView({ ticket }: { ticket: string }) {
  const t = useTranslations("handoff");
  const te = useTranslations("errors");
  const errorMessage = useErrorMessage();
  const preferences = usePreferences();
  const qc = useQueryClient();
  const here = `/handoff/${encodeURIComponent(ticket)}`;
  const [failure, setFailure] = useState<unknown>();
  const [switching, setSwitching] = useState(false);
  const { mutateAsync: redeem } = useAppMutation({
    fn: () => {
      let pending = redeems.get(ticket);
      if (pending === undefined) {
        pending = redeemHandoff(ticket);
        redeems.set(ticket, pending);
      }
      return pending;
    },
    invalidates: () => [],
  });
  const { mutateAsync: postLogout } = useAppMutation({ fn: logout, invalidates: () => [] });

  useEffect(() => {
    // Only the last mount acts on the answer: the shared redeem is never sent twice, and the
    // browser navigates once.
    let live = true;
    redeem(undefined).then(
      ({ location }) => {
        if (!live) return;
        if (isHandoffLocation(location)) navigateBrowser(location);
        else setFailure(BAD_LOCATION);
      },
      (e: unknown) => {
        if (!live) return;
        if (needsLogin(e)) navigateBrowser(loginPathFor(here));
        else setFailure(e);
      },
    );
    return () => {
      live = false;
    };
  }, [redeem, here]);

  // Sign out (as the account menu does), then sign in again and come back here. The ticket is
  // spent already: this only helps the person's next attempt from the app.
  async function onSwitchAccount() {
    setSwitching(true);
    markSigningOut();
    try {
      await postLogout(undefined);
    } catch {
      // the sign-in page still asks: a session that survived goes on to this page
    } finally {
      broadcastSession("signed-out");
      await resetSession(qc, () => navigateBrowser(loginPathFor(here)));
    }
  }

  if (failure === undefined) {
    return (
      <AuthPage title={t("title")} preferences={preferences}>
        <div role="status">
          <Text variant="prose" tone="muted">
            {t("opening")}
          </Text>
        </div>
      </AuthPage>
    );
  }
  const code = codeOf(failure);
  const mismatch = code === "handoff.account_mismatch";
  const title =
    code === "handoff.invalid"
      ? t("invalidTitle")
      : mismatch
        ? t("mismatchTitle")
        : t("failedTitle");
  const message = mismatch
    ? te("handoff.account_mismatch", { login: ownerOf(failure) })
    : errorMessage(failure);
  return (
    <AuthPage title={title} preferences={preferences}>
      <Stack gap={16}>
        <FormError message={message} />
        <Text variant="prose" tone="muted">
          {t("startAgain")}
        </Text>
        {mismatch ? (
          <Button
            variant="primary"
            density="prominent"
            loading={switching}
            onClick={() => void onSwitchAccount()}
          >
            {t("switchAccount")}
          </Button>
        ) : null}
      </Stack>
    </AuthPage>
  );
}
