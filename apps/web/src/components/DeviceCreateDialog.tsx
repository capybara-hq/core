"use client";

import { Button, Dialog, Field, Input, Select, Stack, Text, useToast } from "@capybara-hq/design";
import { useQuery } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "../i18n/navigation";
import {
  createDevice,
  type Device,
  type DeviceProviderOption,
  deviceText,
  isDeviceName,
} from "../lib/devices";
import { extensionLabel, labelLocale } from "../lib/extension-label";
import { devicesQuery } from "../lib/query/devices";
import { keys } from "../lib/query/keys";
import { useAppMutation } from "../lib/query/mutation";
import { useErrorMessage } from "../lib/use-error-message";
import { useConnectThisMachine } from "../lib/use-this-machine";
import { FormError } from "./form-error";
import { SetupGuideSection } from "./SetupGuideSection";

/** How often the dialog reads the devices while it waits for a machine to connect. */
const WAIT_POLL_MS = 3000;

/**
 * New device on the Devices page: a 设备类型 select of the device providers on in the org (the
 * org's default preselected when it is one, else the first; read-only with one provider), the
 * chosen provider's description as the field's help and, under it, its connection guide. The
 * dialog body scrolls under a fixed head and footer, so a long guide keeps the actions reachable.
 *
 * - A provider that creates devices itself: a name (1-64 characters) and Create (primary, disabled
 *   until the name is valid). A created device is ready at once: the dialog invalidates the list
 *   and opens its page. A kernel refusal (name taken, limit reached) keeps the dialog open with its
 *   copy.
 * - A dial-in provider (a machine signs in): no name; the guide says how (a provider without one
 *   gets a line to ask an org admin), and the dialog reads the devices until one of that provider
 *   it had not seen appears, and opens its page.
 * - In the desktop shell the guide's shell-action block is a primary Connect this machine button;
 *   in a browser it draws nothing.
 */
export function DeviceCreateDialog({
  orgId,
  providers,
  defaultProvider,
  onClose,
}: {
  orgId: string;
  providers: DeviceProviderOption[];
  defaultProvider?: string | null;
  onClose(): void;
}) {
  const t = useTranslations("devices.create");
  const toast = useToast();
  const router = useRouter();
  const errorMessage = useErrorMessage();
  const locale = labelLocale(useLocale());
  const [plugin, setPlugin] = useState(
    providers.find((p) => p.plugin === defaultProvider)?.plugin ?? providers[0]?.plugin ?? "",
  );
  const chosen = providers.find((p) => p.plugin === plugin);
  const dialIn = chosen?.dialIn === true;
  const [name, setName] = useState("");
  const [error, setError] = useState<string>();
  const create = useAppMutation({
    fn: () => createDevice(orgId, { name, provider: plugin }),
    invalidates: (_, r) => [keys.org(orgId).devices(), keys.org(orgId).device(r.device.id)],
  });
  const valid = isDeviceName(name);

  const submit = async () => {
    if (!valid || create.isPending || dialIn) return;
    setError(undefined);
    try {
      const r = await create.mutateAsync(undefined);
      toast.success(t("created", { name: r.device.name ?? name.trim() }));
      onClose();
      router.push(`/devices/${encodeURIComponent(r.device.id)}`);
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const connected = (e: Device) => {
    toast.success(t("connected", { name: e.name ?? "" }));
    onClose();
    router.push(`/devices/${encodeURIComponent(e.id)}`);
  };

  // The wait lives here, not in the guide: the dialog body remounts when the window crosses 600,
  // and the snapshot of known devices is taken once per wait.
  useWatchNewDevice(orgId, dialIn ? plugin : null, connected);

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !create.isPending) onClose();
      }}
      title={t("title")}
      // a connection guide carries commands to copy: the wider ordinary dialog
      size={640}
      footer={
        dialIn ? (
          <Button variant="ghost" onClick={onClose}>
            {t("close")}
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose} disabled={create.isPending}>
              {t("cancel")}
            </Button>
            <Button
              variant="primary"
              loading={create.isPending}
              disabled={!valid || create.isPending}
              onClick={() => void submit()}
            >
              {t("submit")}
            </Button>
          </>
        )
      }
    >
      <Stack gap={16}>
        <Field
          label={t("providerLabel")}
          // the chosen provider's description, as one short line under the picker
          {...(chosen?.description != null && {
            help: deviceText(chosen.description, locale),
          })}
        >
          <Select
            value={plugin}
            // one provider is still shown as the select, read-only: the same field in every org
            disabled={providers.length < 2}
            onChange={(e) => {
              setPlugin(e.target.value);
              setError(undefined);
            }}
            options={providers.map((p) => ({
              value: p.plugin,
              label: extensionLabel({ name: p.plugin, displayName: p.displayName }, locale),
            }))}
          />
        </Field>
        {chosen?.guide != null && (
          <SetupGuideSection
            // a provider's guide is its own: switching starts over
            key={chosen.plugin}
            orgId={orgId}
            guide={chosen.guide}
            query={{ audience: "member" }}
            renderShellAction={(_, label) => <ConnectThisMachine orgId={orgId} label={label} />}
          />
        )}
        {dialIn && chosen?.guide == null && (
          <Text variant="prose" tone="muted">
            {t("noGuide")}
          </Text>
        )}
        {!dialIn && (
          <Stack gap={12}>
            <Field label={t("name")} required help={t("nameHelp")}>
              <Input
                value={name}
                maxLength={64}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void submit();
                }}
              />
            </Field>
            {error !== undefined && <FormError message={error} />}
          </Stack>
        )}
      </Stack>
    </Dialog>
  );
}

/**
 * The wait for a machine to connect, owned by the dialog (one per open): while `enabled` the devices
 * are read every few seconds, and the first device of `provider` that was not there when the wait began, or
 * whose machine changed since (a login again into an existing device replaces its machine), is the
 * newly connected machine.
 */
function useWatchNewDevice(
  orgId: string,
  provider: string | null,
  onConnected: (e: Device) => void,
) {
  const enabled = provider !== null;
  const list = useQuery({
    ...devicesQuery(orgId),
    enabled,
    refetchInterval: WAIT_POLL_MS,
  });
  // device id of the provider -> its machine id when the wait began (null: none connected)
  const known = useRef<Map<string, string | null> | null>(null);
  const done = useRef(false);
  // A wait that begins again (another provider, then back) snapshots afresh, from a read made after it
  // began; the first wait may snapshot what the page already holds.
  const since = useRef(0);
  const waited = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a wait restarts when its provider changes
  useEffect(() => {
    if (known.current !== null) waited.current = true;
    known.current = null;
    since.current = enabled && waited.current ? Date.now() : 0;
  }, [provider]);
  useEffect(() => {
    if (!enabled || list.data === undefined || done.current) return;
    if (list.dataUpdatedAt < since.current) return;
    const locals = list.data.items.filter((e) => e.provider === provider);
    if (known.current === null) {
      known.current = new Map(locals.map((e) => [e.id, e.machine?.id ?? null]));
      return;
    }
    const seen = known.current;
    const fresh = locals.find(
      (e) => !seen.has(e.id) || (e.machine !== null && e.machine.id !== (seen.get(e.id) ?? null)),
    );
    if (fresh !== undefined) {
      done.current = true;
      onConnected(fresh);
    }
  }, [enabled, provider, list.data, list.dataUpdatedAt, onConnected]);
}

/**
 * The guide's shell-action block: the primary Connect this machine button, only in a shell that
 * offers `device@2` (a browser draws nothing). The shell's `connect` adds a connection into this
 * org and runs inside the click-driven mutation (`useConnectThisMachine`), so the shell sees the
 * person's activation; a cancel shows nothing.
 */
function ConnectThisMachine({ orgId, label }: { orgId: string; label: string }) {
  const t = useTranslations("devices.create");
  const { offered, pending, failed, connect } = useConnectThisMachine(orgId);
  if (!offered) return null;
  return (
    <Stack gap={8}>
      <Stack direction="row">
        <Button variant="primary" loading={pending} disabled={pending} onClick={connect}>
          {label}
        </Button>
      </Stack>
      {failed && <FormError message={t("connectFailed")} />}
    </Stack>
  );
}
