"use client";

import {
  Button,
  ContentSection,
  Dialog,
  Field,
  FormSection,
  formatBytes,
  formatDateTime,
  Input,
  ItemList,
  KeycapCommand,
  KeyValue,
  RadioGroup,
  Stack,
  Text,
  useTimeZone,
  useToast,
} from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { osLabel } from "../lib/device-sign-in";
import {
  type Device,
  type DeviceMode,
  type DeviceModeChange,
  type DevicePolicyPatch,
  setDeviceMode,
  updateDevicePolicy,
} from "../lib/devices";
import { allowHostProblem, normalizeHost } from "../lib/network-hosts";
import { keys } from "../lib/query/keys";
import { useAppMutation } from "../lib/query/mutation";
import { ApiErrorDetail } from "./ApiErrorDetail";

/** The only CLI line a device page shows (spec §6.42): the owner switches the mode at the machine. */
export const MODE_COMMAND = "capybara-device mode auto|sandbox";

/**
 * 概览: what the device is and does now, read only (auto mode spec §4; the device page's split of
 * values and controls, 2026-11-14). The band above already says origin, state and mode, so the tab
 * adds only what it does not: the network's hosts (a local device in sandbox mode), a cloud device's
 * provider and resources, a local machine's system, and what the files are. Every control lives in
 * 设置; this tab links there.
 */
export function DeviceOverview({
  device: e,
  onOpenSettings,
}: {
  device: Device;
  onOpenSettings(): void;
}) {
  const t = useTranslations("devices");
  const tc = useTranslations("devices.network");
  const local = e.source === "local";
  const sandbox = e.mode.mode === "sandbox";
  const hosts = local ? (e.mode.local?.allowedDomains ?? []) : (e.mode.network.hosts ?? []);
  const showNetwork =
    sandbox && (local || (e.mode.network.kind === "allowlist" && hosts.length > 0));
  return (
    <Stack gap={12}>
      {showNetwork && (
        <ContentSection
          title={tc("title")}
          description={local ? tc("overviewNote") : tc(`cloudHint.${e.mode.network.source}`)}
          {...(local
            ? {
                actions: (
                  <Button density="dense" onClick={onOpenSettings}>
                    {t("overview.editNetwork")}
                  </Button>
                ),
              }
            : {})}
        >
          <ItemList
            label={tc("domains")}
            rows={hosts.map((host) => ({ id: host, title: host }))}
            empty={tc("domainsEmpty")}
          />
        </ContentSection>
      )}
      {!local && (
        <ContentSection title={t("detail.resources")}>
          <KeyValue
            keyWidth="10ch"
            rows={[
              { k: t("detail.provider"), v: e.provider ?? t("none") },
              {
                k: t("detail.resources"),
                v: t("detail.resourcesValue", {
                  cpu: e.limits.cpu,
                  memory: formatBytes(e.limits.memoryMb * 1024 * 1024),
                  disk: formatBytes(e.limits.diskMb * 1024 * 1024),
                }),
              },
            ]}
          />
        </ContentSection>
      )}
      {local && e.machine !== null && (
        <ContentSection title={t("machine.title")}>
          <KeyValue keyWidth="10ch" rows={[{ k: t("machine.os"), v: osLabel(e.machine.os) }]} />
        </ContentSection>
      )}
      {!e.filesLost && (
        <ContentSection title={t("files.title")}>
          <Text variant="prose" tone="muted">
            {t(local ? "detail.localFilesNote" : "detail.filesAndSuspendNote")}
          </Text>
        </ContentSection>
      )}
    </Stack>
  );
}

/**
 * 设置: the device's controls, and the only place they live (2026-11-14). 运行模式 is card radios —
 * the app's choice-with-consequences control (§6.3), as the org sandbox page draws the same kind of
 * choice. A local machine switches to auto itself, and the page narrows it to sandbox through the
 * policy op. A cloud device's owner switches both ways (hardening spec D2), each after a
 * confirmation naming the effect (W1): the network it will reach (the 沙箱 card and the dialog name
 * the org's actual cloud network, D3), that running processes may end, and how to switch back
 * (sandbox → auto clears the choice, `mode: null`). A card that cannot be chosen is disabled and
 * carries its reason (W2). 网络 edits a local device's allowlist in sandbox mode through the
 * machine. The page's danger zone follows this block, and 断开这台机器 lives with the machine.
 */
export function DeviceSettings({
  orgId,
  device: e,
  onDisconnect,
}: {
  orgId: string;
  device: Device;
  onDisconnect(): void;
}) {
  const t = useTranslations("devices");
  const toast = useToast();
  const [failure, setFailure] = useState<unknown>(null);
  const [confirming, setConfirming] = useState<DeviceMode | null>(null);
  const change = useAppMutation({
    fn: (patch: DevicePolicyPatch) => updateDevicePolicy(orgId, e.id, patch),
    invalidates: () => [keys.org(orgId).devices(), keys.org(orgId).device(e.id)],
  });
  const cloudMode = useAppMutation({
    fn: (next: DeviceMode) => setDeviceMode(orgId, e.id, next === "sandbox" ? "sandbox" : null),
    invalidates: () => [keys.org(orgId).devices(), keys.org(orgId).device(e.id)],
  });
  const m = e.mode;
  const local = e.source === "local";
  const pending = change.isPending || cloudMode.isPending;
  const canApply =
    local && e.online === true && (e.network?.features.includes("policyOpId") ?? false);
  const disabledReason = !local
    ? undefined
    : e.machine === null
      ? t("mode.noMachine")
      : e.online !== true
        ? t("mode.offline")
        : !(e.network?.features.includes("policyOpId") ?? false)
          ? t("mode.upgrade")
          : undefined;

  const send = async (patch: DevicePolicyPatch, done: string) => {
    setFailure(null);
    try {
      await change.mutateAsync(patch);
      toast.success(done);
      return true;
    } catch (err) {
      setFailure(err);
      return false;
    }
  };
  const applyCloud = async (next: DeviceMode) => {
    if (pending) return;
    setFailure(null);
    try {
      await cloudMode.mutateAsync(next);
      setConfirming(null);
      toast.success(next === "sandbox" ? t("mode.changedSandbox") : t("mode.changedAuto"));
    } catch (err) {
      setConfirming(null);
      setFailure(err);
    }
  };
  const switchMode = (next: DeviceMode) => {
    if (pending || next === m.mode) return;
    if (local) {
      // Auto mode is switched on only at the machine: choosing it sends nothing.
      if (next === "sandbox" && canApply) void send({ mode: "sandbox" }, t("mode.changedSandbox"));
      return;
    }
    // a cloud device's switch, either way, is confirmed first
    setConfirming(next);
  };

  // The auto card: a local machine in sandbox turns auto on itself; a cloud device needs auto to
  // be allowed. The sandbox card: a local device needs its machine connected, online and current.
  const autoReason =
    m.allowedMode === "sandbox"
      ? local
        ? t("mode.unavailable")
        : t("mode.lockedSandbox")
      : local && m.mode === "sandbox"
        ? t("mode.autoOnMachine")
        : undefined;
  const sandboxReason = local && m.mode !== "sandbox" ? disabledReason : undefined;
  const net = m.sandboxNetwork;
  const sandboxDescription = local
    ? t("mode.description.sandbox")
    : net === null || net.kind === "open-public"
      ? t("mode.cloudSandboxNetwork.open")
      : t("mode.cloudSandboxNetwork.allowlist", { count: net.hosts.length });

  return (
    <>
      <FormSection
        id="mode"
        title={t("mode.title")}
        description={local ? t("mode.section.local") : t("mode.section.cloud")}
      >
        <Stack gap={12}>
          <RadioGroup
            label={t("mode.title")}
            variant="card"
            value={m.mode}
            disabled={pending}
            onChange={(v) => switchMode(v as DeviceMode)}
            options={[
              {
                value: "auto",
                label: t("mode.name.auto"),
                description:
                  autoReason ??
                  (local ? t("mode.description.auto") : t("mode.cloudDescription.auto")),
                disabled: autoReason !== undefined,
              },
              {
                value: "sandbox",
                label: t("mode.name.sandbox"),
                description: sandboxReason ?? sandboxDescription,
                disabled: sandboxReason !== undefined,
              },
            ]}
          />
          {m.pendingNextUse && (
            <Text variant="prose" tone="muted">
              {t("mode.pendingNextUse")}
            </Text>
          )}
          {m.pendingFilesReset && (
            <Text variant="prose" tone="warn">
              {t("mode.pendingFilesReset")}
            </Text>
          )}
          {local && <KeycapCommand command={MODE_COMMAND} hint={t("mode.commandHint")} />}
        </Stack>
      </FormSection>
      {confirming !== null && (
        <ModeConfirmDialog
          next={confirming}
          sandboxNetwork={net}
          pending={cloudMode.isPending}
          onCancel={() => setConfirming(null)}
          onConfirm={() => void applyCloud(confirming)}
        />
      )}
      {local && m.mode === "sandbox" && (
        <LocalAllowlist device={e} pending={pending} onSend={send} />
      )}
      {local && e.machine !== null && (
        <FormSection id="machine" title={t("machine.title")} description={t("machine.description")}>
          <div>
            <Button density="dense" onClick={onDisconnect}>
              {t("machine.revoke")}
            </Button>
          </div>
        </FormSection>
      )}
      {failure !== null && <ApiErrorDetail error={failure} open />}
    </>
  );
}

/**
 * The confirmation of a cloud device's mode switch (hardening spec W1): the network it will reach
 * (sandbox: the org's actual cloud network, D3), that its running processes may end, and how to
 * switch back (D2).
 */
function ModeConfirmDialog({
  next,
  sandboxNetwork,
  pending,
  onCancel,
  onConfirm,
}: {
  next: DeviceMode;
  sandboxNetwork: Device["mode"]["sandboxNetwork"];
  pending: boolean;
  onCancel(): void;
  onConfirm(): void;
}) {
  const t = useTranslations("devices.mode.confirm");
  const network =
    next === "auto"
      ? t("network.auto")
      : sandboxNetwork === null || sandboxNetwork.kind === "open-public"
        ? t("network.open")
        : t("network.allowlist", { count: sandboxNetwork.hosts.length });
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) onCancel();
      }}
      title={t(`title.${next}`)}
      footer={
        <>
          <Button variant="ghost" onClick={onCancel} disabled={pending}>
            {t("cancel")}
          </Button>
          <Button variant="primary" loading={pending} disabled={pending} onClick={onConfirm}>
            {t(`submit.${next}`)}
          </Button>
        </>
      }
    >
      <Stack gap={8}>
        <Text variant="prose">{network}</Text>
        <Text variant="prose">{t("processes")}</Text>
        <Text variant="prose" tone="muted">
          {t(`back.${next}`)}
        </Text>
      </Stack>
    </Dialog>
  );
}

/**
 * The recent mode and policy changes: what, when, by whom and from where; a change sent to the
 * machine that did not take effect is marked. Its own section, named like the page's others.
 */
export function RecentChanges({ recent }: { recent: DeviceModeChange[] }) {
  const t = useTranslations("devices.recent");
  const tw = useTranslations("devices.mode");
  const zone = useTimeZone();
  if (recent.length === 0) return null;
  const modeName = (mode: DeviceMode) => tw(`name.${mode}`);
  const modeText = (c: DeviceModeChange["mode"]) =>
    c === null
      ? []
      : c.from != null
        ? [t("modeFrom", { from: modeName(c.from), to: modeName(c.to) })]
        : [t("mode", { mode: modeName(c.to) })];
  const what = (c: DeviceModeChange) =>
    [
      ...(c.add.length > 0 ? [t("add", { hosts: c.add.join(", ") })] : []),
      ...(c.remove.length > 0 ? [t("remove", { hosts: c.remove.join(", ") })] : []),
      ...modeText(c.mode),
    ].join(" · ");
  return (
    <ContentSection title={t("title")}>
      <ItemList
        label={t("title")}
        rows={recent.map((c, i) => ({
          id: `${c.at}:${i}`,
          title: what(c) || t("none"),
          meta: [
            formatDateTime(c.at, "full", zone),
            // a report of the machine names nobody; a change made on it, its owner
            ...(c.via === "device" && (c.kind !== "policy" || c.by === null)
              ? []
              : [c.by ?? t("unknownBy")]),
            t(`via.${c.via}`),
          ].join(" · "),
          ...(c.outcome === "applied" ? {} : { status: { label: t(`outcome.${c.outcome}`) } }),
        }))}
      />
    </ContentSection>
  );
}

/**
 * A local device's sandbox-mode allowlist (network ask-to-allow spec §7, auto mode spec §4.4): the
 * hosts with 移除 each (narrowing, always accepted), and 添加域名 in a dialog (widening asks the
 * machine). A program without the `policyOpId` feature must be upgraded first; a Docker-mode
 * machine cannot limit single domains.
 */
function LocalAllowlist({
  device: e,
  pending,
  onSend,
}: {
  device: Device;
  pending: boolean;
  onSend(patch: DevicePolicyPatch, done: string): Promise<boolean>;
}) {
  const t = useTranslations("devices.network");
  const [adding, setAdding] = useState(false);
  const network = e.network;
  const canApply = network?.features.includes("policyOpId") ?? false;
  const docker = e.machine?.mode === "docker";
  // widening (add) needs the machine's help; narrowing is always sent
  const canWiden = canApply && !docker;
  const domains = e.mode.local?.allowedDomains ?? [];
  return (
    <FormSection
      id="network"
      title={t("title")}
      description={`${t("description")}${docker ? ` ${t("dockerNote")}` : ""}`}
    >
      <Stack gap={12}>
        {network === null ? (
          <Text variant="prose" tone="muted">
            {t("unknown")}
          </Text>
        ) : (
          <>
            {!canApply && (
              <Text variant="prose" tone="warn">
                {t("upgrade")}
              </Text>
            )}
            <ItemList
              label={t("domains")}
              rows={domains.map((h) => ({
                id: h,
                title: h,
                ...(canApply
                  ? {
                      actions: (
                        <Button
                          density="dense"
                          disabled={pending}
                          aria-label={t("removeLabel", { host: h })}
                          onClick={() => void onSend({ remove: [h] }, t("removed", { host: h }))}
                        >
                          {t("remove")}
                        </Button>
                      ),
                    }
                  : {}),
              }))}
              empty={t("domainsEmpty")}
            />
            <div>
              <Button density="dense" disabled={!canWiden} onClick={() => setAdding(true)}>
                {t("add")}
              </Button>
            </div>
            <Text variant="prose" tone="muted">
              {canWiden ? t("addHelp") : t("addDisabled")}
            </Text>
          </>
        )}
      </Stack>
      {adding && (
        <AddHostDialog
          pending={pending}
          domains={domains}
          onClose={() => setAdding(false)}
          onAdd={async (host) => {
            const ok = await onSend({ add: [host] }, t("added", { host }));
            if (ok) setAdding(false);
            return ok;
          }}
        />
      )}
    </FormSection>
  );
}

/** One host: an exact name (files.example.com) or a wildcard (*.example.com). */
function AddHostDialog({
  pending,
  domains,
  onClose,
  onAdd,
}: {
  pending: boolean;
  domains: string[];
  onClose(): void;
  onAdd(host: string): Promise<boolean>;
}) {
  const t = useTranslations("devices.network");
  const [host, setHost] = useState("");
  const [problem, setProblem] = useState<string>();
  const normalized = normalizeHost(host);
  const valid = host.trim() !== "" && allowHostProblem(normalized, { wildcard: true }) === null;
  const submit = async () => {
    if (!valid || pending) return;
    if (domains.includes(normalized)) {
      setProblem(t("hostPresent"));
      return;
    }
    setProblem(undefined);
    const ok = await onAdd(normalized);
    if (ok) setHost("");
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
      title={t("addTitle")}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={pending}>
            {t("cancel")}
          </Button>
          <Button
            variant="primary"
            loading={pending}
            disabled={!valid || pending}
            onClick={() => void submit()}
          >
            {t("addSubmit")}
          </Button>
        </>
      }
    >
      <Field
        label={t("addField")}
        required
        help={t("addHelp")}
        {...(problem !== undefined ? { error: problem } : {})}
      >
        <Input
          value={host}
          maxLength={253}
          placeholder="*.example.com"
          onChange={(ev) => {
            setHost(ev.target.value);
            setProblem(undefined);
          }}
          onKeyDown={(ev) => {
            if (ev.key === "Enter") void submit();
          }}
        />
      </Field>
    </Dialog>
  );
}
