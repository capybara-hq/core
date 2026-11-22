"use client";

import {
  Button,
  ContentSection,
  Field,
  FormSection,
  formatBytes,
  formatDateTime,
  ItemList,
  ItemListItem,
  KeyValue,
  RadioGroup,
  Stack,
  Subsection,
  Text,
  Textarea,
  useTimeZone,
  useToast,
} from "@capybara-hq/design";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { osLabel } from "../lib/device-sign-in";
import {
  type Device,
  type DeviceCeilingChangeSide,
  type DeviceNetworkMode,
  type DeviceNetworkSetting,
  type DeviceSandboxView,
  type DeviceSettingChange,
  deviceText,
  setCloudDeviceNetwork,
} from "../lib/devices";
import { labelLocale } from "../lib/extension-label";
import { allowHostProblem } from "../lib/network-hosts";
import { keys } from "../lib/query/keys";
import { useAppMutation } from "../lib/query/mutation";
import { ApiErrorDetail } from "./ApiErrorDetail";
import { Person } from "./Person";

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
 * The sandbox facts, read only (approval-only profiles design, "UI"): the network and whether a
 * call may run outside the sandbox (a dial-in device; another device's instance is its sandbox).
 */
function SandboxFacts({ device: e }: { device: Device }) {
  const t = useTranslations("devices.sandbox");
  const s = e.sandbox;
  return (
    <KeyValue
      keyWidth="14ch"
      rows={[
        { k: t("network"), v: networkText(t, s.network) },
        ...(e.dialIn ? [{ k: t("outside"), v: outsideText(t, s.outsideSandbox) }] : []),
      ]}
    />
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
  const lang = labelLocale(useLocale());
  const local = e.dialIn;
  const sandbox = e.sandbox;
  const hosts = sandbox.hosts;
  // the hosts matter only under an allowlist: the open network has none to list
  const showNetwork =
    sandbox.network === "allowlist" && ((local && e.machine !== null) || hosts.length > 0);
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
              : tc(sandbox.ownNetwork == null ? "cloudHint.org" : "cloudHint.device")
          }
          {...(local
            ? {}
            : {
                actions: (
                  <Button density="dense" onClick={onOpenSettings}>
                    {t("overview.editNetwork")}
                  </Button>
                ),
              })}
        >
          <ItemList
            label={tc("domains")}
            rows={hosts.map((host) => ({ id: host, title: host }))}
            empty={tc("domainsEmpty")}
          />
        </ContentSection>
      )}
      {!local && !e.available && (
        <ContentSection title={t("detail.provider")}>
          <KeyValue
            keyWidth="10ch"
            rows={[{ k: t("detail.provider"), v: e.provider ?? t("none") }]}
          />
        </ContentSection>
      )}
      {!local && e.available && (
        <ContentSection title={t("detail.resources")}>
          <KeyValue
            keyWidth="10ch"
            rows={[
              { k: t("detail.provider"), v: e.provider ?? t("none") },
              ...(e.report === null
                ? []
                : [{ k: t("detail.about"), v: deviceText(e.report.description, lang) }]),
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
 * its permission profile; the device keeps its sandbox, the same under every profile:
 * - a dial-in device's sandbox is its owner's, kept on the machine: the page has no sandbox
 *   control for it (phase 3 rewrites this page); it offers disconnecting the machine;
 * - any other device's network is changed by its owner in either direction within the platform,
 *   org and provider ceilings, or follows the org again.
 * A disabled option names the layer that limits it.
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
  const cloudChange = useAppMutation({
    fn: (network: { mode: DeviceNetworkMode | null; hosts?: string[] }) =>
      setCloudDeviceNetwork(orgId, e.id, network),
    invalidates,
  });
  const local = e.dialIn;
  const pending = cloudChange.isPending;

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
      {!local && e.available && (
        <FormSection id="sandbox" title={ts("title")} description={ts("sectionCloud")}>
          <Stack gap={16}>
            {e.sandbox.pendingNextUse && (
              <Text variant="prose" tone="muted">
                {ts("pendingNextUse")}
              </Text>
            )}
            {e.sandbox.pendingFilesReset && (
              <Text variant="prose" tone="warn">
                {ts("pendingFilesReset")}
              </Text>
            )}
            <CloudNetwork
              // a saved network starts the draft again from what the kernel answers
              key={`${e.sandbox.ownNetwork}:${e.sandbox.allowedDomains.join(",")}`}
              sandbox={e.sandbox}
              pending={pending}
              onSave={saveCloud}
            />
          </Stack>
        </FormSection>
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

/** A network choice: the device's own network, or `follow` (its org's, `mode: null`). */
type CloudChoice = DeviceNetworkMode | "follow";

/**
 * A device's network, changed by its owner in either direction within the platform, org and
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
      <ItemList label={t("title")}>
        {recent.map((c, i) => {
          // a report of the machine names nobody; a change made on it, its owner
          const named = !(c.via === "device" && (c.kind !== "policy" || c.by === null));
          return (
            <ItemListItem
              // biome-ignore lint/suspicious/noArrayIndexKey: the changes have no id; the list is positional
              key={`${c.at}:${i}`}
              title={what(c) || t("none")}
              {...(c.outcome === "applied"
                ? {}
                : {
                    marks: (
                      <Text variant="small" tone="muted">
                        {t(`outcome.${c.outcome}`)}
                      </Text>
                    ),
                  })}
              meta={
                <>
                  {formatDateTime(c.at, "full", zone)}
                  {" · "}
                  {named ? (
                    <>
                      {c.by === null ? t("unknownBy") : <Person person={c.by} size={16} />}
                      {" · "}
                    </>
                  ) : null}
                  {t(`via.${c.via}`)}
                </>
              }
            />
          );
        })}
      </ItemList>
    </ContentSection>
  );
}
