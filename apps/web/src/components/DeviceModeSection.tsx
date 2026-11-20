"use client";

import {
  Button,
  ContentSection,
  Field,
  FormSection,
  formatBytes,
  formatDateTime,
  ItemList,
  KeycapCommand,
  KeyValue,
  RadioGroup,
  Stack,
  Subsection,
  Text,
  Textarea,
  useTimeZone,
  useToast,
} from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { osLabel } from "../lib/device-sign-in";
import {
  type Device,
  type DeviceCeilingChangeSide,
  type DeviceNetworkMode,
  type DeviceNetworkSetting,
  type DevicePolicyPatch,
  type DeviceSandboxView,
  type DeviceSettingChange,
  deviceCeilingOf,
  setCloudDeviceNetwork,
  updateDevicePolicy,
} from "../lib/devices";
import { allowHostProblem } from "../lib/network-hosts";
import { keys } from "../lib/query/keys";
import { useAppMutation } from "../lib/query/mutation";
import { ApiErrorDetail } from "./ApiErrorDetail";

/**
 * The CLI lines a device page shows for a local machine: its owner widens the sandbox on the
 * machine itself; the page can only narrow it (approval-only profiles design, "Settings model").
 */
export const SANDBOX_COMMANDS = {
  network: "capybara-device ceiling set --network open",
  outside: "capybara-device ceiling set --outside-sandbox on",
  host: "capybara-device policy add allowedDomains <host>",
  reach: "capybara-device ceiling set --project-reach os-user",
} as const;

type Translate = ReturnType<typeof useTranslations>;

/** A host list as typed (one per line, or separated by spaces or commas): trimmed, lowercased, unique. */
const parseHosts = (text: string): string[] => [
  ...new Set(
    text
      .split(/[\s,]+/)
      .map((h) => h.trim().toLowerCase())
      .filter((h) => h !== ""),
  ),
];

/** A network value as people read it. */
const networkText = (t: Translate, n: DeviceNetworkMode) => t(`networkValue.${n}`);
/** Networks from the narrowest to the widest. */
const NETWORK_ORDER: readonly DeviceNetworkMode[] = ["none", "allowlist", "open"];
const wider = (a: DeviceNetworkMode, b: DeviceNetworkMode) =>
  NETWORK_ORDER.indexOf(a) > NETWORK_ORDER.indexOf(b);
/** Whether running outside the sandbox may be granted, as people read it. */
const outsideText = (t: Translate, allowed: boolean) =>
  t(`outsideValue.${allowed ? "allowed" : "off"}`);

/**
 * The sandbox facts, read only (approval-only profiles design, "UI"): the network, whether a call
 * may run outside the sandbox (a local machine; a cloud device's instance is its sandbox), a local
 * machine's project reach and when it reported them, and one notice when the facts are not current.
 */
function SandboxFacts({ device: e }: { device: Device }) {
  const t = useTranslations("devices.sandbox");
  const zone = useTimeZone();
  const f = deviceCeilingOf(e);
  const local = e.source === "local";
  const observed = local ? (e.ownerCeiling?.observedAt ?? null) : null;
  const s = f.sandbox;
  return (
    <Stack gap={8}>
      <KeyValue
        keyWidth="14ch"
        rows={[
          { k: t("network"), v: s === null ? t("unknown") : networkText(t, s.network) },
          ...(local
            ? [{ k: t("outside"), v: s === null ? t("unknown") : outsideText(t, s.outsideSandbox) }]
            : []),
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
 * controls, 2026-11-14). The band above says origin and state; the tab adds the sandbox, the hosts
 * an allowlist reaches, a cloud device's provider and resources, a local machine's system, and what
 * the files are. Every control lives in Settings; this tab links there.
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
  const sandbox = deviceCeilingOf(e).sandbox;
  const hosts = sandbox?.hosts ?? [];
  // the hosts matter only under an allowlist: the open network has none to list
  const showNetwork =
    sandbox?.network === "allowlist" && ((local && e.machine !== null) || hosts.length > 0);
  return (
    <Stack gap={12}>
      <ContentSection title={t("sandbox.title")}>
        <SandboxFacts device={e} />
      </ContentSection>
      {showNetwork && (
        <ContentSection
          title={tc("title")}
          description={
            local
              ? tc("overviewNote")
              : tc(sandbox?.ownNetwork == null ? "cloudHint.org" : "cloudHint.device")
          }
          actions={
            <Button density="dense" onClick={onOpenSettings}>
              {t("overview.editNetwork")}
            </Button>
          }
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
 * Settings: the device's controls, and the only place they live (2026-11-14). A conversation picks
 * its permission profile; the device keeps its sandbox, the same under every profile, in one
 * Sandbox section with its network, running outside the sandbox and the project reach:
 * - a local machine's sandbox is its owner's, widened only on the machine (the commands as
 *   keycaps); the page only narrows it through the policy op (the allowlist, removing hosts,
 *   running outside the sandbox off, the workspace reach), and only while the machine is online,
 *   current and able to take it, else it says why;
 * - a cloud device's network is changed by its owner in either direction within the platform,
 *   org and provider ceilings, or follows the org again; it never runs outside its instance.
 * A disabled option names the layer that limits it. Disconnect this machine follows; the page's
 * danger zone follows this block.
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
  const ts = useTranslations("devices.sandbox");
  const toast = useToast();
  const [failure, setFailure] = useState<unknown>(null);
  // a sandbox change can change what a conversation may do: the device's key holds its
  // permission previews too, so invalidating it reads them again
  const invalidates = () => [keys.org(orgId).devices(), keys.org(orgId).device(e.id)];
  const change = useAppMutation({
    fn: (patch: DevicePolicyPatch) => updateDevicePolicy(orgId, e.id, patch),
    invalidates,
  });
  const cloudChange = useAppMutation({
    fn: (network: { mode: DeviceNetworkMode | null; hosts?: string[] }) =>
      setCloudDeviceNetwork(orgId, e.id, network),
    invalidates,
  });
  const local = e.source === "local";
  const facts = deviceCeilingOf(e);
  const pending = change.isPending || cloudChange.isPending;

  const send = async (patch: DevicePolicyPatch, done: string) => {
    setFailure(null);
    try {
      await change.mutateAsync(patch);
      toast.success(done);
    } catch (err) {
      setFailure(err);
    }
  };
  const saveCloud = async (network: { mode: DeviceNetworkMode | null; hosts?: string[] }) => {
    setFailure(null);
    try {
      await cloudChange.mutateAsync(network);
      toast.success(ts("saved"));
      return true;
    } catch (err) {
      setFailure(err);
      return false;
    }
  };
  return (
    <>
      <FormSection
        id="sandbox"
        title={ts("title")}
        description={ts(local ? "sectionLocal" : "sectionCloud")}
      >
        <Stack gap={16}>
          {facts.notice !== null && (
            <Text variant="prose" tone={facts.notice === "stale" ? "muted" : "warn"}>
              {ts(`notice.${facts.notice}`)}
            </Text>
          )}
          {!local && e.sandbox.pendingNextUse && (
            <Text variant="prose" tone="muted">
              {ts("pendingNextUse")}
            </Text>
          )}
          {!local && e.sandbox.pendingFilesReset && (
            <Text variant="prose" tone="warn">
              {ts("pendingFilesReset")}
            </Text>
          )}
          {local ? (
            <LocalSandbox device={e} pending={pending} onSend={(p, done) => void send(p, done)} />
          ) : facts.sandbox != null ? (
            <CloudNetwork
              // a saved network starts the draft again from what the kernel answers
              key={`${facts.sandbox.ownNetwork}:${facts.sandbox.allowedDomains.join(",")}`}
              sandbox={facts.sandbox}
              pending={pending}
              onSave={saveCloud}
            />
          ) : null}
        </Stack>
      </FormSection>
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
 * The widening commands that would change something on this machine: the open network while the
 * device itself keeps it narrower (a platform, org or provider limit is not lifted on the
 * machine), running outside the sandbox likewise, adding a host while the network is an
 * allowlist, and the wider project reach while it is the workspace. Every command while the
 * sandbox is unknown.
 */
export function wideningCommands(
  s: DeviceSandboxView | null,
  reach: "workspace" | "os-user" | null,
): (keyof typeof SANDBOX_COMMANDS)[] {
  if (s === null) return Object.keys(SANDBOX_COMMANDS) as (keyof typeof SANDBOX_COMMANDS)[];
  const byDevice = (layer: DeviceSandboxView["layer"]["network"]) =>
    layer === null || layer === "device";
  return [
    ...(s.network !== "open" && byDevice(s.layer.network) ? (["network"] as const) : []),
    ...(!s.outsideSandbox && byDevice(s.layer.outsideSandbox) ? (["outside"] as const) : []),
    ...(s.network === "allowlist" ? (["host"] as const) : []),
    ...(reach !== "os-user" ? (["reach"] as const) : []),
  ];
}

/**
 * A local machine's sandbox controls: the network (only the allowlist can be chosen here, its hosts
 * only removed), running outside the sandbox (only off) and the project reach (only the
 * workspace), each sent to the machine through the policy op. A machine that cannot take the change
 * now says why once and its controls are disabled, never refused; without a usable report there is
 * nothing to change. The widening commands follow as keycaps while a machine is connected.
 */
function LocalSandbox({
  device: e,
  pending,
  onSend,
}: {
  device: Device;
  pending: boolean;
  onSend(patch: DevicePolicyPatch, done: string): void;
}) {
  const t = useTranslations("devices.sandbox");
  const facts = deviceCeilingOf(e);
  const s = facts.sandbox;
  const owner = facts.owner;
  const canApply =
    e.online === true &&
    owner !== null &&
    !owner.stale &&
    (e.network?.features.includes("policyOpId") ?? false);
  const disabled = !canApply || pending;
  const widening = wideningCommands(s, owner === null ? null : owner.restrictedProjectReach);
  const commands =
    e.machine === null || widening.length === 0 ? null : (
      <Stack gap={8}>
        <Text variant="prose" tone="muted">
          {t("widenLocal")}
        </Text>
        {widening.map((k) => (
          <KeycapCommand key={k} command={SANDBOX_COMMANDS[k]} hint={t(`command.${k}`)} />
        ))}
      </Stack>
    );
  if (s === null || owner === null) return commands;
  const hosts = owner.allowedDomains;
  return (
    <Stack gap={16}>
      {!canApply && (
        <Text variant="prose" tone="muted">
          {t(e.online !== true || owner.stale ? "cannotNarrow.offline" : "cannotNarrow.upgrade")}
        </Text>
      )}
      <Subsection title={t("network")}>
        <Stack gap={12}>
          <RadioGroup
            label={t("network")}
            value={s.network === "open" ? "open" : "allowlist"}
            disabled={disabled}
            onChange={(v) => {
              if (v === "allowlist" && s.network === "open")
                onSend({ ownerCeiling: { network: "allowlist" } }, t("networkNarrowed"));
            }}
            options={[
              {
                value: "open",
                label: networkText(t, "open"),
                // the machine widens only on the machine; a platform or org ceiling names itself
                ...(s.network !== "open"
                  ? {
                      disabled: true,
                      description: t(
                        `limited.${s.network === "none" ? "closed" : "network"}.${s.layer.network ?? "device"}`,
                      ),
                    }
                  : {}),
              },
              { value: "allowlist", label: networkText(t, "allowlist") },
            ]}
          />
          {(s.network !== "open" || hosts.length > 0) && (
            <ItemList
              label={t("hosts")}
              rows={hosts.map((h) => ({
                id: h,
                title: h,
                ...(canApply
                  ? {
                      actions: (
                        <Button
                          density="dense"
                          disabled={pending}
                          aria-label={t("removeLabel", { host: h })}
                          onClick={() => onSend({ remove: [h] }, t("removed", { host: h }))}
                        >
                          {t("remove")}
                        </Button>
                      ),
                    }
                  : {}),
              }))}
              empty={t("hostsEmpty")}
            />
          )}
          {(s.network !== "open" || hosts.length > 0) && (
            <Text variant="prose" tone="muted">
              {t("localHostsHelp")}
            </Text>
          )}
        </Stack>
      </Subsection>
      <Subsection title={t("outside")}>
        <RadioGroup
          label={t("outside")}
          value={s.outsideSandbox ? "allowed" : "off"}
          disabled={disabled}
          onChange={(v) => {
            if (v === "off" && s.outsideSandbox)
              onSend({ ownerCeiling: { outsideSandbox: false } }, t("outsideOff"));
          }}
          options={[
            {
              value: "allowed",
              label: outsideText(t, true),
              ...(!s.outsideSandbox
                ? {
                    disabled: true,
                    description: t(`limited.outside.${s.layer.outsideSandbox ?? "device"}`),
                  }
                : {}),
            },
            { value: "off", label: outsideText(t, false) },
          ]}
        />
      </Subsection>
      <Subsection title={t("reach")}>
        <Stack gap={8}>
          <Text variant="prose">{t(`reachValue.${owner.restrictedProjectReach}`)}</Text>
          {owner.restrictedProjectReach === "os-user" && canApply && (
            <div>
              <Button
                density="dense"
                disabled={pending}
                onClick={() =>
                  onSend(
                    { ownerCeiling: { restrictedProjectReach: "workspace" } },
                    t("reachLimited"),
                  )
                }
              >
                {t("limitReach")}
              </Button>
            </div>
          )}
        </Stack>
      </Subsection>
      {commands}
    </Stack>
  );
}

/** A cloud network choice: the device's own network, or `follow` (its org's, `mode: null`). */
type CloudChoice = DeviceNetworkMode | "follow";

/**
 * A cloud device's network, changed by its owner in either direction within the platform, org and
 * provider ceilings (`PATCH` with `{ network: { mode, hosts? } }`): follow the organization
 * (`mode: null`), the open internet (private networks blocked), an allowlist whose hosts only
 * narrow the organization's list (empty follows its hosts), or closed. A network above the ceiling
 * is disabled and names the layer that set it; the kernel refuses it too
 * (`device.network_not_allowed`).
 */
function CloudNetwork({
  sandbox: s,
  pending,
  onSave,
}: {
  sandbox: DeviceSandboxView;
  pending: boolean;
  onSave(network: { mode: DeviceNetworkMode | null; hosts?: string[] }): Promise<boolean>;
}) {
  const t = useTranslations("devices.sandbox");
  const initial: CloudChoice = s.ownNetwork ?? "follow";
  const [choice, setChoice] = useState<CloudChoice>(initial);
  const [text, setText] = useState(s.allowedDomains.join("\n"));
  const hosts = parseHosts(text);
  const bad = hosts.find((h) => allowHostProblem(h, { wildcard: true }) !== null);
  const changed =
    choice !== initial ||
    (choice === "allowlist" && hosts.join("\n") !== s.allowedDomains.join("\n"));
  const layer = s.layer.network ?? "provider";
  const limit = (n: DeviceNetworkMode) =>
    wider(n, s.networkCeiling)
      ? {
          disabled: true,
          description: t(`limited.${s.networkCeiling === "none" ? "closed" : "network"}.${layer}`),
        }
      : {};
  const save = () =>
    void onSave(
      choice === "follow"
        ? { mode: null }
        : choice === "allowlist"
          ? { mode: "allowlist", hosts }
          : { mode: choice },
    );
  return (
    <Subsection title={t("network")}>
      <Stack gap={12}>
        <RadioGroup
          label={t("network")}
          value={choice}
          disabled={pending}
          onChange={(v) => {
            const next = (["follow", ...NETWORK_ORDER] as const).find((x) => x === v);
            if (next !== undefined) setChoice(next);
          }}
          options={[
            {
              value: "follow",
              label: t("followOrg"),
              ...(s.ownNetwork === null
                ? { description: t("followOrgNow", { value: networkText(t, s.network) }) }
                : {}),
            },
            { value: "open", label: networkText(t, "open"), ...limit("open") },
            { value: "allowlist", label: networkText(t, "allowlist"), ...limit("allowlist") },
            { value: "none", label: networkText(t, "none") },
          ]}
        />
        {choice === "allowlist" && (
          <Field
            label={t("cloudHosts")}
            help={t("cloudHostsHelp")}
            {...(bad !== undefined ? { error: t("invalidHost", { host: bad }) } : {})}
          >
            <Textarea
              code
              rows={4}
              value={text}
              disabled={pending}
              placeholder="files.example.com"
              onChange={(ev) => setText(ev.target.value)}
            />
          </Field>
        )}
        <div>
          <Button
            density="dense"
            variant="primary"
            loading={pending}
            disabled={!changed || bad !== undefined || pending}
            onClick={save}
          >
            {t("save")}
          </Button>
        </div>
      </Stack>
    </Subsection>
  );
}

/**
 * The recent setting changes: what, when, by whom and from where; a change sent to the machine
 * that did not take effect is marked. A setting change names each setting it changed with its from
 * and to values: a machine's owner ceiling (the network, running outside the sandbox, the project
 * reach) or a cloud device's network (following the organization, or its own network and hosts).
 */
export function RecentChanges({ recent }: { recent: DeviceSettingChange[] }) {
  const t = useTranslations("devices.recent");
  const ts = useTranslations("devices.sandbox");
  const zone = useTimeZone();
  if (recent.length === 0) return null;
  const line = (setting: string, before: string | undefined, after: string) =>
    before !== undefined
      ? t("change", { setting, from: before, to: after })
      : t("set", { setting, to: after });
  const ceilingTexts = (c: DeviceSettingChange["ceiling"]) => {
    if (c === null) return [];
    const from: Partial<DeviceCeilingChangeSide> = c.from ?? {};
    const out: string[] = [];
    const to = c.to;
    if (to.network !== undefined && from.network !== to.network)
      out.push(
        line(
          ts("network"),
          from.network === undefined ? undefined : networkText(ts, from.network),
          networkText(ts, to.network),
        ),
      );
    if (from.outsideSandbox !== to.outsideSandbox)
      out.push(
        line(
          ts("outside"),
          from.outsideSandbox === undefined ? undefined : outsideText(ts, from.outsideSandbox),
          outsideText(ts, to.outsideSandbox),
        ),
      );
    if (
      to.restrictedProjectReach !== undefined &&
      from.restrictedProjectReach !== to.restrictedProjectReach
    )
      out.push(
        line(
          ts("reach"),
          from.restrictedProjectReach === undefined
            ? undefined
            : ts(`reachValue.${from.restrictedProjectReach}`),
          ts(`reachValue.${to.restrictedProjectReach}`),
        ),
      );
    return out;
  };
  const networkSetting = (n: DeviceNetworkSetting) =>
    n.mode === null
      ? ts("followOrg")
      : n.mode === "allowlist" && n.hosts.length > 0
        ? t("withHosts", { value: networkText(ts, n.mode), hosts: n.hosts.join(", ") })
        : networkText(ts, n.mode);
  const networkTexts = (c: DeviceSettingChange["network"]) =>
    c === null ? [] : [line(ts("network"), networkSetting(c.from), networkSetting(c.to))];
  const what = (c: DeviceSettingChange) =>
    [
      ...(c.add.length > 0 ? [t("add", { hosts: c.add.join(", ") })] : []),
      ...(c.remove.length > 0 ? [t("remove", { hosts: c.remove.join(", ") })] : []),
      ...ceilingTexts(c.ceiling ?? null),
      ...networkTexts(c.network ?? null),
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
