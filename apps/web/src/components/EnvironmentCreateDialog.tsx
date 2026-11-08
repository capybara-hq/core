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
import { DEVICE_INSTALL_COMMAND, deviceLoginCommand } from "../lib/devices";
import { createEnvironment, type Environment, isEnvironmentName } from "../lib/environments";
import { environmentsQuery } from "../lib/query/environments";
import { keys } from "../lib/query/keys";
import { useAppMutation } from "../lib/query/mutation";
import { useErrorMessage } from "../lib/use-error-message";
import { FormError } from "./form-error";

/** How often the dialog reads the environments while it waits for a machine to connect. */
const WAIT_POLL_MS = 3000;

type Kind = "cloud" | "device";

/**
 * 新建环境 on the 环境 page: two choices, 云端沙箱 and 接入设备 (only 接入设备, without the choice,
 * when the platform has no cloud sandbox).
 *
 * - 云端沙箱: one field, 名称 (1-64 characters); the primary is disabled until it is valid. A created
 *   environment is ready at once (its files and instance are made on first use): the dialog
 *   invalidates the list and opens the detail page. A kernel refusal (name taken, limit reached,
 *   no provider) keeps the dialog open with its copy.
 * - 接入设备: the two commands to run on the machine (install, then `capybara-device login` with
 *   this deployment's address), each with a copy button; the dialog then reads the environments
 *   until a connected environment it had not seen appears, and opens its page.
 */
export function EnvironmentCreateDialog({
  orgId,
  cloudAvailable,
  onClose,
}: {
  orgId: string;
  cloudAvailable: boolean;
  onClose(): void;
}) {
  const t = useTranslations("environments.create");
  const toast = useToast();
  const router = useRouter();
  const errorMessage = useErrorMessage();
  const [kind, setKind] = useState<Kind>(cloudAvailable ? "cloud" : "device");
  const [name, setName] = useState("");
  const [error, setError] = useState<string>();
  const create = useAppMutation({
    fn: () => createEnvironment(orgId, name),
    invalidates: (_, r) => [
      keys.org(orgId).environments(),
      keys.org(orgId).environment(r.environment.id),
    ],
  });
  const valid = isEnvironmentName(name);

  const submit = async () => {
    if (!valid || create.isPending) return;
    setError(undefined);
    try {
      const r = await create.mutateAsync(undefined);
      toast.success(t("created", { name: r.environment.name ?? name.trim() }));
      onClose();
      router.push(`/environments/${encodeURIComponent(r.environment.id)}`);
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const connected = (e: Environment) => {
    toast.success(t("connected", { name: e.name ?? "" }));
    onClose();
    router.push(`/environments/${encodeURIComponent(e.id)}`);
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
              { value: "device", label: t("device"), description: t("deviceHint") },
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
          <DeviceSteps orgId={orgId} onConnected={connected} />
        )}
      </Stack>
    </Dialog>
  );
}

/**
 * The commands that connect a machine, then the wait: the environments are read every few
 * seconds, and the first connected environment that was not there when the steps opened is the
 * new machine.
 */
function DeviceSteps({ orgId, onConnected }: { orgId: string; onConnected(e: Environment): void }) {
  const t = useTranslations("environments.create");
  // The deployment's address, read after mount (a server render has no window).
  const [origin, setOrigin] = useState("");
  useEffect(() => setOrigin(window.location.origin), []);
  const list = useQuery({ ...environmentsQuery(orgId), refetchInterval: WAIT_POLL_MS });
  const known = useRef<Set<string> | null>(null);
  const done = useRef(false);
  useEffect(() => {
    if (list.data === undefined || done.current) return;
    const devices = list.data.items.filter((e) => e.source === "device");
    if (known.current === null) {
      known.current = new Set(devices.map((e) => e.id));
      return;
    }
    const seen = known.current;
    const fresh = devices.find((e) => !seen.has(e.id));
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
      <Text variant="prose" tone="muted" icon="spinner">
        {t("waiting")}
      </Text>
    </Stack>
  );
}

/** One command to run on the machine: a read-only field and its copy button. */
function CommandStep({ label, command }: { label: string; command: string }) {
  const t = useTranslations("environments.create");
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
