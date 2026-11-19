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
  type DeviceModeChange,
  type DevicePolicyPatch,
  deviceCeilingOf,
  narrowCloudDevice,
  updateDevicePolicy,
  widenCloudDevice,
} from "../lib/devices";
import { allowHostProblem, normalizeHost } from "../lib/network-hosts";
import { keys } from "../lib/query/keys";
import { useAppMutation } from "../lib/query/mutation";
import { ApiErrorDetail } from "./ApiErrorDetail";
import { WidenCeiling } from "./ThisMachineSection";

/**
 * The only CLI line a device page shows: the owner widens (or sets) a machine's ceiling on the
 * machine itself (`capybara-device ceiling set`); the page can only narrow it.
 */
export const CEILING_COMMAND =
  "capybara-device ceiling set --full-access allow|deny --project-reach workspace|os-user";

/**
 * The owner ceiling's facts, read only (permission profiles spec, "Device and execution model"):
 * whether Full access is available here and why not, a local machine's project reach and when it
 * reported them, and one notice when the facts are not current. Shared by the Overview and Settings tabs.
 */
function CeilingFacts({ device: e }: { device: Device }) {
  const t = useTranslations("devices.ceiling");
  const zone = useTimeZone();
  const f = deviceCeilingOf(e);
  const local = e.source === "local";
  const observed = local ? (e.ownerCeiling?.observedAt ?? null) : null;
  return (
    <Stack gap={8}>
      <KeyValue
        keyWidth="12ch"
        rows={[
          { k: t("fullAccess"), v: t(`full.${f.full}`) },
          ...(local && f.reach !== null ? [{ k: t("reach"), v: t(`reachValue.${f.reach}`) }] : []),
          ...(observed !== null
            ? [{ k: t("reported"), v: formatDateTime(observed, "full", zone) }]
            : []),
        ]}
      />
      {f.notice !== null && (
        <Text variant="prose" tone={f.notice === "stale" ? "muted" : "warn"}>
          {t(`notice.${f.notice}`)}
        </Text>
      )}
    </Stack>
  );
}

/**
 * Overview: what the device is and does now, read only (the device page's split of values and
 * controls, 2026-11-14). The band above says origin and state; the tab adds the owner ceiling, the
 * network restricted work reaches (a local machine's allowlist, a cloud device's org allowlist), a
 * cloud device's provider and resources, a local machine's system, and what the files are. Every
 * control lives in Settings; this tab links there.
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
  const hosts = local ? (e.mode.local?.allowedDomains ?? []) : (e.mode.network.hosts ?? []);
  const showNetwork =
    (local && e.machine !== null) || (e.mode.network.kind === "allowlist" && hosts.length > 0);
  return (
    <Stack gap={12}>
      <ContentSection title={t("ceiling.title")}>
        <CeilingFacts device={e} />
      </ContentSection>
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

/** A cloud device's ceiling change waiting for its confirmation. */
type CloudChange = "widen" | "narrow";

/**
 * Settings: the device's controls, and the only place they live (2026-11-14). There is no daily mode
 * any more (permission profiles spec): a conversation picks its permission profile, and the device
 * only keeps its owner's ceiling. Access ceiling shows that ceiling and the controls the kernel allows:
 * - a local machine's ceiling is its owner's, widened only on the machine (`capybara-device
 *   ceiling set`, shown as keycaps); the page only narrows it through the policy op (Full access
 *   off, the project reach to the workspace; an older program's one narrowing turns both off), and
 *   only while the machine is connected, online and able to take it, else it says why;
 * - a cloud device's owner turns Full access off, or on again within what the platform and the org
 *   allow, each after a confirmation naming the effect; a widening is never sent without
 *   `confirmWidening`, and never from anywhere but that confirmation.
 * Network edits a local machine's allowlist through the machine. Disconnect this machine lives with the machine,
 * and the page's danger zone follows this block.
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
  const [confirming, setConfirming] = useState<CloudChange | null>(null);
  // a ceiling change can change what a conversation may choose: the device's key holds its
  // permission previews too, so invalidating it reads them again
  const invalidates = () => [keys.org(orgId).devices(), keys.org(orgId).device(e.id)];
  const change = useAppMutation({
    fn: (patch: DevicePolicyPatch) => updateDevicePolicy(orgId, e.id, patch),
    invalidates,
  });
  const cloudChange = useAppMutation({
    fn: (next: CloudChange) =>
      next === "widen"
        ? widenCloudDevice(orgId, e.id)
        : narrowCloudDevice(orgId, e.id, (e.ownerCeiling ?? null) !== null),
    invalidates,
  });
  const local = e.source === "local";
  const pending = change.isPending || cloudChange.isPending;
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
  const applyCloud = async (next: CloudChange) => {
    if (pending) return;
    setFailure(null);
    try {
      await cloudChange.mutateAsync(next);
      setConfirming(null);
      toast.success(t(next === "widen" ? "ceiling.fullOn" : "ceiling.fullOff"));
    } catch (err) {
      setConfirming(null);
      setFailure(err);
    }
  };
  return (
    <>
      <FormSection
        id="ceiling"
        title={t("ceiling.title")}
        description={t(local ? "ceiling.sectionLocal" : "ceiling.sectionCloud")}
      >
        <Stack gap={12}>
          <CeilingFacts device={e} />
          {!local && e.mode.pendingNextUse && (
            <Text variant="prose" tone="muted">
              {t("ceiling.pendingNextUse")}
            </Text>
          )}
          {!local && e.mode.pendingFilesReset && (
            <Text variant="prose" tone="warn">
              {t("ceiling.pendingFilesReset")}
            </Text>
          )}
          {local ? (
            <LocalNarrowing
              device={e}
              canApply={canApply}
              pending={pending}
              onSend={(patch, done) => void send(patch, done)}
            />
          ) : (
            <CloudControls device={e} pending={pending} onChoose={setConfirming} />
          )}
          {local && e.machine !== null && (
            <WidenCeiling
              orgId={orgId}
              device={e}
              invalidates={invalidates}
              fallback={<KeycapCommand command={CEILING_COMMAND} hint={t("ceiling.widenLocal")} />}
            />
          )}
        </Stack>
      </FormSection>
      {confirming !== null && (
        <CeilingConfirmDialog
          device={e}
          change={confirming}
          pending={cloudChange.isPending}
          onCancel={() => setConfirming(null)}
          onConfirm={() => void applyCloud(confirming)}
        />
      )}
      {local && e.machine !== null && <LocalAllowlist device={e} pending={pending} onSend={send} />}
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
 * A local machine's narrowing (B2: the policy op takes `fullAccess: false` and the `workspace`
 * reach only). An authenticated report narrows each field on its own; an older program's report
 * (`legacy`) has one narrowing, its old sandbox switch, which turns both off at once. Nothing is
 * offered when there is nothing to narrow or no usable report; a machine that cannot take the
 * change now says why instead of drawing a button that would be refused.
 */
function LocalNarrowing({
  device: e,
  canApply,
  pending,
  onSend,
}: {
  device: Device;
  canApply: boolean;
  pending: boolean;
  onSend(patch: DevicePolicyPatch, done: string): void;
}) {
  const t = useTranslations("devices.ceiling");
  const c = e.ownerCeiling ?? null;
  if (c === null || (c.state !== "report" && c.state !== "legacy")) return null;
  const narrowFull = c.fullAccess;
  const narrowReach = c.restrictedProjectReach === "os-user";
  if (!narrowFull && !narrowReach) return null;
  if (!canApply) {
    return (
      <Text variant="prose" tone="muted">
        {t(e.online !== true ? "cannotNarrow.offline" : "cannotNarrow.upgrade")}
      </Text>
    );
  }
  if (c.state === "legacy") {
    return (
      <Stack gap={8}>
        <div>
          <Button
            density="dense"
            disabled={pending}
            onClick={() => onSend({ mode: "sandbox" }, t("fullOff"))}
          >
            {t("turnOffFull")}
          </Button>
        </div>
        <Text variant="prose" tone="muted">
          {t("legacyNarrowNote")}
        </Text>
      </Stack>
    );
  }
  return (
    <Stack direction="row" gap={8} wrap>
      {narrowFull && (
        <Button
          density="dense"
          disabled={pending}
          onClick={() => onSend({ ownerCeiling: { fullAccess: false } }, t("fullOff"))}
        >
          {t("turnOffFull")}
        </Button>
      )}
      {narrowReach && (
        <Button
          density="dense"
          disabled={pending}
          onClick={() =>
            onSend({ ownerCeiling: { restrictedProjectReach: "workspace" } }, t("reachLimited"))
          }
        >
          {t("limitReach")}
        </Button>
      )}
    </Stack>
  );
}

/**
 * A cloud device's one control: Full access off while it is effectively on (its ceiling allows it
 * and so do the platform and the org; an old sandbox switch already keeps it off), or allowed again
 * while the platform and the org allow it and the device's permissions were migrated (before that
 * the kernel takes only the narrowing). While the platform or the org keeps it off there is nothing
 * to turn off, and the reason is shown instead. A choice opens its confirmation; nothing is sent
 * here.
 */
function CloudControls({
  device: e,
  pending,
  onChoose,
}: {
  device: Device;
  pending: boolean;
  onChoose(change: CloudChange): void;
}) {
  const t = useTranslations("devices.ceiling");
  const f = deviceCeilingOf(e);
  if (f.full === "platform") {
    return (
      <Text variant="prose" tone="muted">
        {t("cloudForbidden")}
      </Text>
    );
  }
  if (f.full === "available") {
    return (
      <div>
        <Button density="dense" disabled={pending} onClick={() => onChoose("narrow")}>
          {t("turnOffFull")}
        </Button>
      </div>
    );
  }
  if ((e.ownerCeiling ?? null) === null || e.mode.allowedMode !== "auto") return null;
  return (
    <div>
      <Button density="dense" disabled={pending} onClick={() => onChoose("widen")}>
        {t("allowFull")}
      </Button>
    </div>
  );
}

/**
 * The network line of a cloud ceiling change, exactly as the kernel computes it: Full off gives
 * the org's cloud network (`mode.sandboxNetwork`), Full allowed the open public network
 * (`mode.fullNetwork`), each already within the device's outer network. Null when the view has
 * none (never for a cloud device).
 */
function confirmNetworkLine(
  t: (key: string, values?: Record<string, string>) => string,
  e: Device,
  change: CloudChange,
): string | null {
  const n = change === "widen" ? e.mode.fullNetwork : e.mode.sandboxNetwork;
  if (n === null) return null;
  if (n.kind === "open-public") return t("network.open");
  if (n.hosts.length === 0) return t("network.none");
  return t("network.allowlist", { hosts: n.hosts.join(", ") });
}

/**
 * The confirmation of a cloud device's ceiling change: what it does to conversations and running
 * work (a narrowing stops Full work now), the network the device then reaches, and that its
 * instance takes the new limits at its next use (it may restart; the files are kept). The
 * widening's confirm is the only place that sends one.
 */
function CeilingConfirmDialog({
  device: e,
  change,
  pending,
  onCancel,
  onConfirm,
}: {
  device: Device;
  change: CloudChange;
  pending: boolean;
  onCancel(): void;
  onConfirm(): void;
}) {
  const t = useTranslations("devices.ceiling.confirm");
  const network = confirmNetworkLine(t, e, change);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) onCancel();
      }}
      title={t(`title.${change}`)}
      footer={
        <>
          <Button variant="ghost" onClick={onCancel} disabled={pending}>
            {t("cancel")}
          </Button>
          <Button variant="primary" loading={pending} disabled={pending} onClick={onConfirm}>
            {t(`submit.${change}`)}
          </Button>
        </>
      }
    >
      <Stack gap={8}>
        <Text variant="prose">{t(`effect.${change}`)}</Text>
        {network !== null && <Text variant="prose">{network}</Text>}
        <Text variant="prose" tone="muted">
          {t("nextUse")}
        </Text>
      </Stack>
    </Dialog>
  );
}

/**
 * The recent ceiling and policy changes: what, when, by whom and from where; a change sent to the
 * machine that did not take effect is marked. An old mode change reads as the ceiling it set (the
 * old auto is the Full ceiling, the old sandbox its narrowing); a ceiling change names what
 * changed (Full access, a machine's project reach).
 */
export function RecentChanges({ recent }: { recent: DeviceModeChange[] }) {
  const t = useTranslations("devices.recent");
  const zone = useTimeZone();
  if (recent.length === 0) return null;
  const modeText = (c: DeviceModeChange["mode"]) =>
    c === null ? [] : [t(c.to === "auto" ? "fullAllowed" : "fullOff")];
  const ceilingText = (c: DeviceModeChange["ceiling"]) => {
    if (c === null) return [];
    const { from, to } = c;
    const reach = to.restrictedProjectReach;
    return [
      ...(from?.fullAccess !== to.fullAccess ? [t(to.fullAccess ? "fullAllowed" : "fullOff")] : []),
      ...(reach !== undefined && from?.restrictedProjectReach !== reach
        ? [t(`reach.${reach}`)]
        : []),
    ];
  };
  const what = (c: DeviceModeChange) =>
    [
      ...(c.add.length > 0 ? [t("add", { hosts: c.add.join(", ") })] : []),
      ...(c.remove.length > 0 ? [t("remove", { hosts: c.remove.join(", ") })] : []),
      ...modeText(c.mode),
      ...ceilingText(c.ceiling ?? null),
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
 * A local machine's allowlist for restricted work (network ask-to-allow spec §7): the
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
