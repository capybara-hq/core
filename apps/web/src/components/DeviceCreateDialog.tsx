"use client";

import {
  Button,
  CopyField,
  Dialog,
  Field,
  Input,
  RadioGroup,
  Select,
  Stack,
  Text,
  useToast,
} from "@capybara-hq/design";
import { useQuery } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "../i18n/navigation";
import {
  DEVICE_INSTALL_COMMAND,
  DEVICE_START_COMMAND,
  deviceLoginCommand,
} from "../lib/device-sign-in";
import { createDevice, type Device, type DeviceProviderOption, isDeviceName } from "../lib/devices";
import { extensionLabel, labelLocale } from "../lib/extension-label";
import { devicesQuery } from "../lib/query/devices";
import { keys } from "../lib/query/keys";
import { useAppMutation } from "../lib/query/mutation";
import { useErrorMessage } from "../lib/use-error-message";
import { useThisMachine } from "../lib/use-this-machine";
import { FormError } from "./form-error";

/** How often the dialog reads the devices while it waits for a machine to connect. */
const WAIT_POLL_MS = 3000;

type Kind = "cloud" | "local";

/**
 * 新建设备 on the 设备 page: two choices, 云端设备 and 本地设备 (only 本地设备, without the choice,
 * when no device provider is on in the org).
 *
 * - Cloud device: a name (1-64 characters) and, with two or more providers on, a provider select (the
 *   default preselected; the request names it); the primary is disabled until it is valid. A created
 *   device is ready at once (its files and instance are made on first use): the dialog
 *   invalidates the list and opens the detail page. A kernel refusal (name taken, limit reached,
 *   no provider) keeps the dialog open with its copy.
 * - Local device: in the desktop shell (`device@1`) a primary "connect this machine" button first (the
 *   shell asks the person natively); the commands to run on the machine (install, `capybara-device login` with
 *   this deployment's address), each a CopyField (the code line with its copy button); the dialog then reads the devices
 *   until a local device it had not seen appears, and opens its page.
 */
export function DeviceCreateDialog({
  orgId,
  providers,
  defaultProvider,
  onClose,
}: {
  orgId: string;
  providers: DeviceProviderOption[];
  defaultProvider: string | null;
  onClose(): void;
}) {
  const t = useTranslations("devices.create");
  const toast = useToast();
  const router = useRouter();
  const errorMessage = useErrorMessage();
  const lang = labelLocale(useLocale());
  const cloudAvailable = providers.length > 0;
  const [kind, setKind] = useState<Kind>(cloudAvailable ? "cloud" : "local");
  const [provider, setProvider] = useState(
    providers.find((p) => p.plugin === defaultProvider)?.plugin ?? providers[0]?.plugin ?? "",
  );
  const [name, setName] = useState("");
  const [error, setError] = useState<string>();
  const create = useAppMutation({
    fn: () => createDevice(orgId, name, provider === "" ? undefined : provider),
    invalidates: (_, r) => [keys.org(orgId).devices(), keys.org(orgId).device(r.device.id)],
  });
  const valid = isDeviceName(name);

  const submit = async () => {
    if (!valid || create.isPending) return;
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

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !create.isPending) onClose();
      }}
      title={t("title")}
      footer={
        kind === "cloud" ? (
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
        ) : (
          <Button variant="ghost" onClick={onClose}>
            {t("close")}
          </Button>
        )
      }
    >
      <Stack gap={16}>
        {cloudAvailable && (
          <RadioGroup
            variant="card"
            label={t("kindLabel")}
            value={kind}
            onChange={(v) => setKind(v as Kind)}
            options={[
              { value: "cloud", label: t("cloud"), description: t("cloudHint") },
              { value: "local", label: t("local"), description: t("localHint") },
            ]}
          />
        )}
        {kind === "cloud" ? (
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
            {providers.length > 1 && (
              <Field label={t("provider")} help={t("providerHelp")}>
                <Select
                  value={provider}
                  onChange={(e) => setProvider(e.target.value)}
                  options={providers.map((p) => ({
                    value: p.plugin,
                    label: extensionLabel({ name: p.plugin, displayName: p.displayName }, lang),
                  }))}
                />
              </Field>
            )}
            {error !== undefined && <FormError message={error} />}
          </Stack>
        ) : (
          <LocalSteps
            orgId={orgId}
            onConnected={connected}
            onOpen={(id) => {
              onClose();
              router.push(`/devices/${encodeURIComponent(id)}`);
            }}
          />
        )}
      </Stack>
    </Dialog>
  );
}

/**
 * The commands that connect a machine, then the wait: the devices are read every few
 * seconds, and the first local device that was not there when the steps opened, or whose
 * machine changed since (a login again into an existing device replaces its machine), is
 * the newly connected machine.
 */
function LocalSteps({
  orgId,
  onConnected,
  onOpen,
}: {
  orgId: string;
  onConnected(e: Device): void;
  onOpen(deviceId: string): void;
}) {
  const t = useTranslations("devices.create");
  const { cap, status } = useThisMachine();
  const [connectError, setConnectError] = useState<string>();
  // `connect` runs inside the click-driven mutation, so the shell sees the person's activation
  const connect = useAppMutation({
    fn: () => {
      if (cap === undefined) return Promise.resolve("cancelled" as const);
      return cap.connect({ orgId });
    },
    invalidates: () => [keys.shell().deviceStatus()],
  });
  const onConnect = async () => {
    if (connect.isPending) return;
    setConnectError(undefined);
    try {
      await connect.mutateAsync(undefined);
    } catch (e) {
      const code = (e as { code?: unknown } | null)?.code;
      if (code !== "cancelled") setConnectError(t("connectFailed"));
    }
  };
  // The deployment's address, read after mount (a server render has no window).
  const [origin, setOrigin] = useState("");
  useEffect(() => setOrigin(window.location.origin), []);
  const list = useQuery({ ...devicesQuery(orgId), refetchInterval: WAIT_POLL_MS });
  // local device id -> its machine id when the steps opened (null: none connected)
  const known = useRef<Map<string, string | null> | null>(null);
  const done = useRef(false);
  useEffect(() => {
    if (list.data === undefined || done.current) return;
    const locals = list.data.items.filter((e) => e.source === "local");
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
  }, [list.data, onConnected]);
  if (status?.state === "connected" && status.orgId === orgId) {
    return (
      <Stack gap={12}>
        <Text variant="prose">
          {t("thisMachineConnected", { state: t(`connection.${status.connection}`) })}
        </Text>
        <Stack direction="row">
          <Button variant="primary" onClick={() => onOpen(status.deviceId)}>
            {t("openDevice")}
          </Button>
        </Stack>
      </Stack>
    );
  }
  return (
    <Stack gap={16}>
      {cap !== undefined && status?.state === "not_connected" && (
        <Stack gap={8}>
          <Stack direction="row">
            <Button
              variant="primary"
              loading={connect.isPending}
              disabled={connect.isPending}
              onClick={() => void onConnect()}
            >
              {t("connectMachine")}
            </Button>
          </Stack>
          {connectError !== undefined && <FormError message={connectError} />}
        </Stack>
      )}
      {status?.state === "connected" && (
        // connected to another org of this person: the terminal steps attach a second org
        <Text variant="prose" tone="muted">
          {t("thisMachineOtherOrg")}
        </Text>
      )}
      {status?.state === "connected_elsewhere" && (
        <Text variant="prose" tone="muted">
          {t("connectedElsewhere", { origin: status.origin })}
        </Text>
      )}
      <CopyField label={t("installStep")} value={DEVICE_INSTALL_COMMAND} />
      <CopyField label={t("loginStep")} value={origin === "" ? "" : deviceLoginCommand(origin)} />
      <CopyField label={t("startStep")} value={DEVICE_START_COMMAND} />
      <Text variant="prose" tone="muted" icon="spinner">
        {t("waiting")}
      </Text>
    </Stack>
  );
}
