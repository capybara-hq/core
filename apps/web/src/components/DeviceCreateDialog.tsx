"use client";

import {
  Button,
  Dialog,
  Field,
  Icon,
  Input,
  RadioGroup,
  Stack,
  Text,
  useToast,
} from "@capybara-hq/design";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "../i18n/navigation";
import {
  DEVICE_INSTALL_COMMAND,
  DEVICE_START_COMMAND,
  deviceLoginCommand,
} from "../lib/device-sign-in";
import { createDevice, type Device, isDeviceName } from "../lib/devices";
import { devicesQuery } from "../lib/query/devices";
import { keys } from "../lib/query/keys";
import { useAppMutation } from "../lib/query/mutation";
import { useErrorMessage } from "../lib/use-error-message";
import { FormError } from "./form-error";

/** How often the dialog reads the devices while it waits for a machine to connect. */
const WAIT_POLL_MS = 3000;

type Kind = "cloud" | "local";

/**
 * 新建设备 on the 设备 page: two choices, 云端设备 and 本地设备 (only 本地设备, without the choice,
 * when the platform has no cloud sandbox).
 *
 * - 云端设备: one field, 名称 (1-64 characters); the primary is disabled until it is valid. A created
 *   device is ready at once (its files and instance are made on first use): the dialog
 *   invalidates the list and opens the detail page. A kernel refusal (name taken, limit reached,
 *   no provider) keeps the dialog open with its copy.
 * - 本地设备: the commands to run on the machine (install, `capybara-device login` with
 *   this deployment's address), each with a copy button; the dialog then reads the devices
 *   until a local device it had not seen appears, and opens its page.
 */
export function DeviceCreateDialog({
  orgId,
  cloudAvailable,
  onClose,
}: {
  orgId: string;
  cloudAvailable: boolean;
  onClose(): void;
}) {
  const t = useTranslations("devices.create");
  const toast = useToast();
  const router = useRouter();
  const errorMessage = useErrorMessage();
  const [kind, setKind] = useState<Kind>(cloudAvailable ? "cloud" : "local");
  const [name, setName] = useState("");
  const [error, setError] = useState<string>();
  const create = useAppMutation({
    fn: () => createDevice(orgId, name),
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
            {error !== undefined && <FormError message={error} />}
          </Stack>
        ) : (
          <LocalSteps orgId={orgId} onConnected={connected} />
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
function LocalSteps({ orgId, onConnected }: { orgId: string; onConnected(e: Device): void }) {
  const t = useTranslations("devices.create");
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
  return (
    <Stack gap={16}>
      <CommandStep label={t("installStep")} command={DEVICE_INSTALL_COMMAND} />
      <CommandStep
        label={t("loginStep")}
        command={origin === "" ? "" : deviceLoginCommand(origin)}
      />
      <CommandStep label={t("startStep")} command={DEVICE_START_COMMAND} />
      <Text variant="prose" tone="muted" icon="spinner">
        {t("waiting")}
      </Text>
    </Stack>
  );
}

/** One command to run on the machine: a read-only field and its copy button. */
function CommandStep({ label, command }: { label: string; command: string }) {
  const t = useTranslations("devices.create");
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      toast.success(t("copied"));
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  return (
    <Stack gap={8}>
      <Field label={label}>
        <Input readOnly value={command} onFocus={(e) => e.target.select()} />
      </Field>
      <Stack direction="row">
        <Button density="dense" disabled={command === ""} onClick={() => void copy()}>
          <Icon name="copy" size={14} />
          {t("copy")}
        </Button>
      </Stack>
    </Stack>
  );
}
