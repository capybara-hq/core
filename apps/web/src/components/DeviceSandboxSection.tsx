"use client";

import {
  Badge,
  Button,
  CodeBlock,
  ContentSection,
  Dialog,
  formatDateTime,
  ItemList,
  KeyValue,
  RadioGroup,
  Stack,
  Text,
  useTimeZone,
  useToast,
} from "@capybara-hq/design";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useState } from "react";
import {
  type Device,
  type DevicePolicyPatch,
  type DeviceSandbox,
  type DeviceSandboxChange,
  deviceCapped,
  SANDBOX_TIERS,
  type SandboxTier,
  setDeviceTier,
  tierAbove,
  updateDevicePolicy,
} from "../lib/devices";
import { retryOnMountOf } from "../lib/query/client";
import { keys } from "../lib/query/keys";
import { useAppMutation } from "../lib/query/mutation";
import { orgSettingsQuery } from "../lib/query/settings";
import { ApiErrorDetail } from "./ApiErrorDetail";

/** The radio value of "follow the org's default" (tier null). */
const FOLLOW = "default";

/** The local commands that turn a device's sandbox off (spec §5.4, §14 Q1: shown, never sent). */
export const UNSANDBOXED_COMMANDS =
  "capybara-device policy set tier open\ncapybara-device policy set isolation none --yes";

/** The local command that raises a device's tier on the machine (`remoteGrants: off`). */
const RAISE_COMMAND = "capybara-device policy set tier <strict|dev|open|default>";

/** The local override for local ports under the macOS proxy guard (spec §5.2). */
const LOCALHOST_COMMAND = "capybara-device policy set localhost allow";

/**
 * Whether setting a local device's tier to `next` (null: the org's default) may raise it, not
 * knowing what the machine resolves the default to (as the kernel's `tierWidens`): a tier above
 * the reported one, any but `strict` when it reports none, following the default from a reported
 * `strict` or `dev`.
 */
export function localTierWidens(reported: SandboxTier | undefined, next: SandboxTier | null) {
  if (next === null) return reported !== undefined && reported !== "open";
  if (reported === undefined) return next !== "strict";
  return tierAbove(next, reported);
}

/**
 * A device's 「沙箱级别」 section (sandbox dev tiers spec §11.1), for every device: the three levels
 * and 「跟随组织默认（…）」 as option cards (one above the ceiling is disabled with who caps it), the
 * effective level and why when it is lower, a cloud device's pending notes (下次使用时生效 / 重置文件后
 * 生效). A local device adds what the development level gives on its machine (local ports, unix
 * sockets), the command to run there when it takes no raise from the platform (`remoteGrants:
 * off`), and, for an OS-mode machine that may reach 开放, the 「不使用沙箱」 row: off, the risk text
 * and the local commands with a copy button (nothing is sent, §14 Q1); on, a danger mark and
 * 恢复沙箱 (a narrowing `policy` op). Choosing 开放 asks first with the risk text. The recent
 * sandbox changes close the section.
 */
export function DeviceSandboxSection({ orgId, device: e }: { orgId: string; device: Device }) {
  const t = useTranslations("devices.sandbox");
  const tt = useTranslations("devices.tier");
  const toast = useToast();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  // who caps a card above the ceiling: the org settings say (members may read them)
  const settingsQ = orgSettingsQuery(orgId);
  const settings = useQuery({
    ...settingsQ,
    enabled: deviceCapped(e),
    retryOnMount: retryOnMountOf(settingsQ.queryKey),
  });
  const invalidates = () => [keys.org(orgId).devices(), keys.org(orgId).device(e.id)];
  const cloudTier = useAppMutation({
    fn: (tier: SandboxTier | null) => setDeviceTier(orgId, e.id, tier),
    invalidates,
  });
  const localPolicy = useAppMutation({
    fn: (patch: DevicePolicyPatch) => updateDevicePolicy(orgId, e.id, patch),
    invalidates,
  });
  const s = e.sandbox;
  if (s === undefined) return null;
  const local = e.source === "local";
  const policy = e.network?.policy ?? null;
  const features = e.network?.features ?? [];
  const pending = cloudTier.isPending || localPolicy.isPending;
  // a local device's tier lives on its machine: it takes changes only through the policy op
  const localBlock: "noMachine" | "upgrade" | "unknown" | null = !local
    ? null
    : e.machine === null || e.network == null
      ? "noMachine"
      : !features.includes("policyOp") || !features.includes("tiers")
        ? "upgrade"
        : policy === null
          ? "unknown"
          : null;
  const remoteOff = local && policy?.remoteGrants === "off";
  const platformMax = settings.data?.deployment?.sandboxTiers?.max;
  // a card above the platform's max names the platform's; one only the org caps, the ceiling
  const capOf = (tier: SandboxTier): string => {
    if (platformMax !== undefined && tierAbove(tier, platformMax)) {
      return t("capped.platform", { tier: tt(platformMax) });
    }
    const by = platformMax !== undefined ? "org" : (s.cappedBy ?? "any");
    return t(`capped.${by}`, { tier: tt(s.ceiling) });
  };
  const widens = (next: SandboxTier | null) => local && localTierWidens(policy?.tier, next);
  const options = [
    {
      value: FOLLOW,
      label: t("follow", { tier: tt(s.defaultTier) }),
      description: t("followHint"),
      ...(remoteOff && widens(null) ? { disabled: true } : {}),
    },
    ...SANDBOX_TIERS.map((tier) => {
      const capped = tierAbove(tier, s.ceiling);
      return {
        value: tier,
        label: tt(tier),
        description: capped ? capOf(tier) : t(`hint.${tier}`),
        ...(capped || (remoteOff && widens(tier)) ? { disabled: true } : {}),
      };
    }),
  ];
  const chosen = s.tier ?? s.defaultTier;
  const lower = tierAbove(chosen, s.effectiveTier);
  const lowerReason = !lower
    ? null
    : s.cappedBy !== null
      ? t(`lower.${s.cappedBy}`, { tier: tt(s.ceiling) })
      : null;

  const send = async (next: SandboxTier | null) => {
    setFailure(null);
    try {
      if (local) await localPolicy.mutateAsync({ tier: next });
      else await cloudTier.mutateAsync(next);
      toast.success(next === null ? t("followed") : t("changed", { tier: tt(next) }));
      return true;
    } catch (err) {
      setFailure(err);
      return false;
    }
  };
  const restore = async () => {
    setFailure(null);
    try {
      await localPolicy.mutateAsync({ isolation: "sandbox" });
      toast.success(t("restored"));
    } catch (err) {
      setFailure(err);
    }
  };

  const unsandboxedRow =
    local &&
    e.machine?.mode === "os" &&
    localBlock === null &&
    (s.isolation === "none" || (s.allowUnsandboxed && s.ceiling === "open"));

  return (
    <ContentSection title={t("title")} description={t("description")}>
      <Stack gap={12}>
        {localBlock !== null && (
          <Text variant="prose" tone={localBlock === "upgrade" ? "warn" : "muted"}>
            {localBlock === "upgrade" && !features.includes("tiers")
              ? t("lower.program")
              : t(localBlock)}
          </Text>
        )}
        <RadioGroup
          label={t("title")}
          variant="card"
          value={s.tier ?? FOLLOW}
          disabled={pending || localBlock !== null}
          onChange={(v) => {
            const next = v === FOLLOW ? null : (v as SandboxTier);
            if (next === "open") setConfirmOpen(true);
            else void send(next);
          }}
          options={options}
        />
        <KeyValue
          keyWidth="14ch"
          rows={[
            { k: t("effective"), v: tt(s.effectiveTier) },
            ...(local && policy !== null && s.effectiveTier !== "strict"
              ? [
                  { k: t("localhost"), v: t(`localhostValue.${policy.localhost}`) },
                  { k: t("unixSockets"), v: t(`unixSocketsValue.${policy.unixSockets}`) },
                ]
              : []),
          ]}
        />
        {lowerReason !== null && (
          <Text variant="small" tone="muted">
            {lowerReason}
          </Text>
        )}
        {local && policy?.localhost === "off-proxy-detected" && s.effectiveTier !== "strict" && (
          <Stack gap={4}>
            <Text variant="small" tone="muted">
              {t("localhostOverride")}
            </Text>
            <CodeBlock language="bash" text={LOCALHOST_COMMAND} copyable />
          </Stack>
        )}
        {local && e.machine?.os === "linux" && e.machine.mode === "os" && (
          <Text variant="small" tone="muted">
            {t("linuxNote")}
          </Text>
        )}
        {!local && s.pendingNextUse && (
          <Text variant="prose" tone="muted">
            {t("pendingNextUse")}
          </Text>
        )}
        {!local && s.pendingFilesReset && (
          <Text variant="prose" tone="warn">
            {t("pendingFilesReset")}
          </Text>
        )}
        {remoteOff && (
          <Stack gap={4}>
            <Text variant="small" tone="muted">
              {t("remoteOff")}
            </Text>
            <CodeBlock language="bash" text={RAISE_COMMAND} copyable />
          </Stack>
        )}
        {unsandboxedRow && (
          <UnsandboxedRow
            sandbox={s}
            pending={pending}
            canRestore={features.includes("policyOp")}
            onRestore={() => void restore()}
          />
        )}
        {failure !== null && <ApiErrorDetail error={failure} open />}
        <RecentChanges recent={s.recent} />
      </Stack>
      {confirmOpen && (
        <OpenTierDialog
          pending={pending}
          onClose={() => setConfirmOpen(false)}
          onConfirm={async () => {
            await send("open");
            setConfirmOpen(false);
          }}
        />
      )}
    </ContentSection>
  );
}

/**
 * 「不使用沙箱」 (spec §5.4, §14 Q1): off, the risk text and the local commands with a copy
 * button (the platform can't turn it on); on, a danger mark, what it means and 恢复沙箱.
 */
function UnsandboxedRow({
  sandbox: s,
  pending,
  canRestore,
  onRestore,
}: {
  sandbox: DeviceSandbox;
  pending: boolean;
  canRestore: boolean;
  onRestore(): void;
}) {
  const t = useTranslations("devices.sandbox");
  const on = s.isolation === "none";
  return (
    <Stack gap={8}>
      <Stack direction="row" gap={8} align="center">
        <Text variant="h3">{t("unsandboxed")}</Text>
        {on && <Badge tone="fail">{t("unsandboxed")}</Badge>}
      </Stack>
      {on ? (
        <>
          <Text variant="prose">{t("unsandboxedOn")}</Text>
          {!s.allowUnsandboxed && (
            <Text variant="prose" tone="warn">
              {t("unsandboxedNotAllowed")}
            </Text>
          )}
          <Stack direction="row" gap={8}>
            <Button disabled={pending || !canRestore} loading={pending} onClick={onRestore}>
              {t("restore")}
            </Button>
          </Stack>
        </>
      ) : (
        <>
          <Text variant="prose" tone="warn">
            {t("unsandboxedRisk")}
          </Text>
          <Text variant="small" tone="muted">
            {t("unsandboxedOffHint")}
          </Text>
          <CodeBlock language="bash" text={UNSANDBOXED_COMMANDS} copyable />
        </>
      )}
    </Stack>
  );
}

/** The device's recent sandbox changes: what, when, by whom and from where; unconfirmed marked. */
function RecentChanges({ recent }: { recent: DeviceSandboxChange[] }) {
  const t = useTranslations("devices.sandbox.recent");
  const tt = useTranslations("devices.tier");
  const zone = useTimeZone();
  if (recent.length === 0) return null;
  const what = (c: DeviceSandboxChange) =>
    [
      ...(c.add.length > 0 ? [t("add", { hosts: c.add.join(", ") })] : []),
      ...(c.remove.length > 0 ? [t("remove", { hosts: c.remove.join(", ") })] : []),
      ...(c.tier !== null
        ? [c.tier.to === null ? t("tierFollow") : t("tier", { tier: tt(c.tier.to) })]
        : []),
      ...(c.isolation !== null ? [t(`isolation.${c.isolation}`)] : []),
    ].join(" · ");
  return (
    <ItemList
      label={t("title")}
      rows={recent.map((c, i) => ({
        id: `${c.at}:${i}`,
        title: what(c) || t("none"),
        meta: [
          formatDateTime(c.at, "full", zone),
          ...(c.via === "device" ? [] : [c.by ?? t("unknownBy")]),
          t(`via.${c.via}`),
        ].join(" · "),
        ...(c.confirmed ? {} : { status: { label: t("unconfirmed") } }),
      }))}
    />
  );
}

/**
 * Choosing 开放: the risk text first, then the change is sent. A dangerous dialog that starts on
 * Cancel.
 */
function OpenTierDialog({
  pending,
  onClose,
  onConfirm,
}: {
  pending: boolean;
  onClose(): void;
  onConfirm(): Promise<void>;
}) {
  const t = useTranslations("devices.sandbox");
  return (
    <Dialog
      open
      danger
      initialFocus="cancel"
      onOpenChange={(o) => {
        if (!o && !pending) onClose();
      }}
      title={t("openConfirmTitle")}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={pending}>
            {t("cancel")}
          </Button>
          <Button
            variant="danger-solid"
            loading={pending}
            disabled={pending}
            onClick={() => void onConfirm()}
          >
            {t("openConfirmSubmit")}
          </Button>
        </>
      }
    >
      <Text variant="prose">{t("openRisk")}</Text>
    </Dialog>
  );
}
