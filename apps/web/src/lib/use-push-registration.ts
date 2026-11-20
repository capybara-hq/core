"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";
import { deletePushRegistration, postPushRegistration } from "./push";
import { keys } from "./query/keys";
import { meQuery } from "./query/shell";
import type { Me } from "./session";
import { type PushCapabilityV1, type PushPermission, usePushCapability } from "./shell";

export type PushState = "unavailable" | "prompt" | "granted" | "denied";

/**
 * This install's push registration (mobile app spec §9.3, plan decisions 2 and 4): `unavailable`
 * without `push@1` (the browser, a shell without push) and until the shell has answered `status()`.
 * `enable()` runs from a click: `register()` (the OS prompt when the permission is `prompt`), `POST`
 * the registration, tell the shell its id (`registered`). With the permission `granted` and no
 * registration id (or a rotated token) the hook registers again by itself on mount, without a
 * click: `register()` shows nothing then, and each start refreshes the server's `last_seen_at`.
 * `disable()` forgets this profile's registration in the shell only; removing it from the
 * deployment is the settings page's 「移除」 and the sign-out.
 */
export function usePushRegistration(): {
  state: PushState;
  enable(): Promise<void>;
  disable(): Promise<void>;
} {
  const cap = usePushCapability();
  const qc = useQueryClient();
  const locale = useLocale() === "zh" ? "zh" : "en";
  const t = useTranslations("notifications.deviceName");
  const [permission, setPermission] = useState<PushPermission | null>(null);

  const post = useCallback(
    async (c: PushCapabilityV1): Promise<void> => {
      const registration = await c.register();
      const { id } = await postPushRegistration({
        ...registration,
        locale,
        deviceName: t(registration.platform),
      });
      await c.registered(id);
      const accountId = qc.getQueryData<Me>(meQuery().queryKey)?.account.id;
      if (accountId !== undefined) {
        await qc.invalidateQueries({ queryKey: keys.account(accountId).pushRegistrations() });
      }
      setPermission("granted");
    },
    [locale, qc, t],
  );

  // The shell's answer, and the silent registration of a granted install that holds none.
  const registeredFor = useRef<PushCapabilityV1 | null>(null);
  useEffect(() => {
    if (cap === undefined) {
      setPermission(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const status = await cap.status();
        if (cancelled) return;
        setPermission(status.permission);
        if (
          status.permission === "granted" &&
          (status.registrationId === null || status.tokenChanged) &&
          registeredFor.current !== cap
        ) {
          registeredFor.current = cap;
          await post(cap);
        }
      } catch {
        // a silent registration that fails is retried at the next start; nothing to show
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [cap, post]);

  const enable = useCallback(async () => {
    if (cap === undefined) return;
    try {
      await post(cap);
    } catch (e) {
      // the person said no in the OS prompt: the permission is now denied
      if ((e as { code?: unknown } | null)?.code === "cancelled") {
        try {
          setPermission((await cap.status()).permission);
        } catch {
          // keep the state we had
        }
      }
      throw e;
    }
  }, [cap, post]);

  const disable = useCallback(async () => {
    await cap?.unregister();
  }, [cap]);

  return {
    state: cap === undefined || permission === null ? "unavailable" : permission,
    enable,
    disable,
  };
}

/**
 * Before a sign-out: deletes this install's registration on the deployment (the session is still
 * valid) and tells the shell to forget it (`unregister()`). Never throws: a failed `DELETE` (the
 * kernel also drops a revoked session's registrations) must not keep the person signed in.
 */
export function useForgetPushRegistration(): () => Promise<void> {
  const cap = usePushCapability();
  return useCallback(async () => {
    if (cap === undefined) return;
    try {
      const { registrationId } = await cap.status();
      if (registrationId !== null) {
        try {
          await deletePushRegistration(registrationId);
        } catch {
          // the kernel's session revocation removes it anyway
        }
      }
      await cap.unregister();
    } catch {
      // a shell that cannot answer does not block signing out
    }
  }, [cap]);
}
