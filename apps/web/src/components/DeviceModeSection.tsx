"use client";

import {
  Badge,
  Button,
  ContentSection,
  Field,
  formatDateTime,
  Input,
  ItemList,
  KeycapCommand,
  ModeScale,
  Stack,
  Text,
  useTimeZone,
  useToast,
} from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { useState } from "react";
import {
  type Device,
  type DeviceMode,
  type DeviceModeChange,
  type DevicePolicyPatch,
  updateDevicePolicy,
} from "../lib/devices";
import { allowHostProblem, normalizeHost } from "../lib/network-hosts";
import { keys } from "../lib/query/keys";
import { useAppMutation } from "../lib/query/mutation";
import { ApiErrorDetail } from "./ApiErrorDetail";

/** The only CLI line a device page shows (spec §6.43): the owner switches the mode at the machine. */
export const MODE_COMMAND = "capybara-device mode auto|sandbox";

/**
 * A device's 「运行模式」 and, in sandbox mode only, its network (auto mode spec §4): the two-state
 * 自动 / 沙箱 scale with one sentence each. A local device switches at its machine: the page shows
 * the `capybara-device mode` keycaps, and choosing 沙箱 narrows it here through the policy op
 * (choosing 自动 sends nothing). A cloud device has no choice: the scale is locked at the mode the
 * organization and the platform settle on, with the reason. In auto mode the network section is
 * gone (a local machine's network is a fact; a cloud auto device is 开放（挡内网）); in sandbox mode
 * a local device's allowlist is edited here, and a cloud device's network is read only from the
 * organization's setting. The recent mode and policy changes close the block.
 */
export function DeviceModeSection({ orgId, device: e }: { orgId: string; device: Device }) {
  const t = useTranslations("devices");
  const toast = useToast();
  const [failure, setFailure] = useState<unknown>(null);
  const change = useAppMutation({
    fn: (patch: DevicePolicyPatch) => updateDevicePolicy(orgId, e.id, patch),
    invalidates: () => [keys.org(orgId).devices(), keys.org(orgId).device(e.id)],
  });
  const m = e.mode;
  const local = e.source === "local";
  const canApply =
    local && e.online === true && (e.network?.features.includes("policyOpId") ?? false);

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

  const switchMode = (next: DeviceMode) => {
    // Auto mode is switched on only at the machine: the web only ever narrows to sandbox.
    if (next !== "sandbox" || !canApply) return;
    void send({ mode: "sandbox" }, t("mode.changedSandbox"));
  };

  const disabledReason = !local
    ? undefined
    : e.machine === null
      ? t("mode.noMachine")
      : e.online !== true
        ? t("mode.offline")
        : !(e.network?.features.includes("policyOpId") ?? false)
          ? t("mode.upgrade")
          : undefined;
  const lockedReason = local
    ? undefined
    : m.allowedMode === "sandbox"
      ? t("mode.lockedSandbox")
      : m.mode === "sandbox"
        ? t("mode.lockedNarrowed")
        : t("mode.lockedCloud");

  return (
    <Stack gap={16}>
      <ModeScale
        value={m.mode}
        {...(!local
          ? {
              descriptions: {
                auto: t("mode.cloudDescription.auto"),
                sandbox: t("mode.cloudDescription.sandbox"),
              },
              locked: true,
              ...(lockedReason !== undefined ? { lockedReason } : {}),
            }
          : {
              descriptions: {
                auto: t("mode.description.auto"),
                sandbox: t("mode.description.sandbox"),
              },
              onSelect: switchMode,
              ...(m.allowedMode === "sandbox"
                ? { unavailable: { auto: t("mode.unavailable") } }
                : {}),
              ...(disabledReason !== undefined ? { disabled: true, disabledReason } : {}),
              command: <KeycapCommand command={MODE_COMMAND} hint={t("mode.commandHint")} />,
            })}
      />
      {m.pendingNextUse && (
        <Text variant="prose" tone="muted">
          {t("mode.pendingNextUse")}
        </Text>
      )}
      {failure !== null && <ApiErrorDetail error={failure} open />}
      <RecentChanges recent={m.recent} />
      {local && m.mode === "sandbox" && (
        <LocalAllowlist device={e} pending={change.isPending} onSend={send} />
      )}
      {!local && m.mode === "sandbox" && (
        <CloudNetwork kind={m.network.kind} hosts={m.network.hosts} />
      )}
    </Stack>
  );
}

/**
 * The recent mode and policy changes: what, when, by whom and from where; a change sent to the
 * machine that did not take effect is marked.
 */
function RecentChanges({ recent }: { recent: DeviceModeChange[] }) {
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
  );
}

/**
 * A local device's sandbox-mode allowlist (network ask-to-allow spec §7, auto mode spec §4.4): a
 * compact list with 移除 each (narrowing, always accepted) and one add field that takes `*.`
 * wildcards. An empty list is one muted line, never an empty-state page. A program without the
 * `policyOpId` feature must be upgraded first; a Docker-mode machine cannot limit single domains.
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
  const [host, setHost] = useState("");
  const [hostError, setHostError] = useState<string>();
  const network = e.network;
  const policy = network?.policy ?? null;
  const canApply = network?.features.includes("policyOpId") ?? false;
  const docker = e.machine?.mode === "docker";
  // widening (add) needs the machine's help; narrowing is always sent
  const canWiden = canApply && !docker;
  const domains = e.mode.local?.allowedDomains ?? [];

  const add = async () => {
    const h = normalizeHost(host);
    const problem = allowHostProblem(h, { wildcard: true });
    if (problem !== null) {
      setHostError(t("hostInvalid"));
      return;
    }
    if (domains.includes(h)) {
      setHostError(t("hostPresent"));
      return;
    }
    setHostError(undefined);
    if (await onSend({ add: [h] }, t("added", { host: h }))) setHost("");
  };

  return (
    <ContentSection title={t("title")} description={t("description")}>
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
            {docker && (
              <Text variant="prose" tone="muted">
                {t("dockerNote")}
              </Text>
            )}
            {policy === null ? (
              <Text variant="prose" tone="muted">
                {t("unknown")}
              </Text>
            ) : (
              <>
                {domains.length === 0 ? (
                  <Text variant="prose" tone="muted">
                    {t("domainsEmpty")}
                  </Text>
                ) : (
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
                                onClick={() =>
                                  void onSend({ remove: [h] }, t("removed", { host: h }))
                                }
                              >
                                {t("remove")}
                              </Button>
                            ),
                          }
                        : {}),
                    }))}
                  />
                )}
                <Field
                  label={t("add")}
                  help={canWiden ? t("addHelp") : t("addDisabled")}
                  {...(hostError !== undefined ? { error: hostError } : {})}
                  action={
                    <Button
                      disabled={!canWiden || pending || host.trim() === ""}
                      onClick={() => void add()}
                    >
                      {t("addSubmit")}
                    </Button>
                  }
                >
                  <Input
                    value={host}
                    maxLength={253}
                    placeholder="*.example.com"
                    disabled={!canWiden || pending}
                    onChange={(ev) => {
                      setHost(ev.target.value);
                      setHostError(undefined);
                    }}
                    onKeyDown={(ev) => {
                      if (ev.key === "Enter") void add();
                    }}
                  />
                </Field>
              </>
            )}
          </>
        )}
      </Stack>
    </ContentSection>
  );
}

/**
 * A cloud device's sandbox-mode network, read only (the organization sets it): 白名单 with its
 * hosts, or 开放（挡内网） when the organization opens it.
 */
function CloudNetwork({ kind, hosts }: { kind: "open-public" | "allowlist"; hosts: string[] }) {
  const t = useTranslations("devices.network");
  const tk = useTranslations("devices.networkKind");
  return (
    <ContentSection title={t("cloudTitle")} description={t("cloudDescription")}>
      <Stack gap={8}>
        <Stack direction="row" gap={8} align="center">
          <Badge tone={kind === "open-public" ? "warn" : "default"}>{tk(kind)}</Badge>
          {kind === "allowlist" && (
            <Text variant="prose" {...(hosts.length === 0 ? { tone: "muted" as const } : {})}>
              {hosts.length === 0 ? t("cloudEmpty") : hosts.join(" · ")}
            </Text>
          )}
        </Stack>
        <Text variant="small" tone="muted">
          {t("cloudHint")}
        </Text>
      </Stack>
    </ContentSection>
  );
}
