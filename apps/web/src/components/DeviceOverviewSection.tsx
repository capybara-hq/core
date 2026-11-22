"use client";

import {
  ContentSection,
  formatDateTime,
  ItemList,
  ItemListItem,
  KeyValue,
  Stack,
  Text,
  useTimeZone,
} from "@capybara-hq/design";
import { useLocale, useTranslations } from "next-intl";
import {
  type Device,
  type DeviceNetworkMode,
  type DeviceNetworkSetting,
  type DeviceSettingChange,
  deviceText,
} from "../lib/devices";
import { labelLocale } from "../lib/extension-label";
import { Person } from "./Person";
import { ThisMachineSection } from "./ThisMachineSection";

/**
 * Overview (device provider design §6.6): values only, the same for every provider. The this-machine
 * block on
 * top (only inside the desktop shell, for this machine's device), then what the provider last
 * reported (its description line in the page language and its limits as read-only rows; no report
 * on a usable device: the provider did not answer), the files note and the recent network changes.
 */
export function DeviceOverviewSection({ orgId, device: e }: { orgId: string; device: Device }) {
  const t = useTranslations("devices");
  const lang = labelLocale(useLocale());
  const report = e.report;
  return (
    <Stack gap={12}>
      <ThisMachineSection orgId={orgId} device={e} />
      {(report !== null || e.available) && (
        <ContentSection title={t("overview.about")}>
          <Stack gap={8}>
            <Text variant="prose" {...(report === null ? { tone: "muted" as const } : {})}>
              {report === null ? t("overview.noReport") : deviceText(report.description, lang)}
            </Text>
            {report !== null && report.limits.length > 0 && (
              <KeyValue
                keyWidth="14ch"
                rows={report.limits.map((l) => ({ k: deviceText(l.label, lang), v: l.value }))}
              />
            )}
          </Stack>
        </ContentSection>
      )}
      {!e.filesLost && (
        <ContentSection title={t("files.title")}>
          <Text variant="prose" tone="muted">
            {t("detail.filesAndSuspendNote")}
          </Text>
        </ContentSection>
      )}
      <RecentChanges recent={e.sandbox.recent} />
    </Stack>
  );
}

/**
 * The device's recent network changes (kind `network`, newest first): from → to, when, by whom
 * and where it was decided (web, IM, an API token or an agent).
 */
function RecentChanges({ recent }: { recent: DeviceSettingChange[] }) {
  const t = useTranslations("devices.recent");
  const tn = useTranslations("devices.network");
  const zone = useTimeZone();
  const changes = recent.filter((c) => c.kind === "network");
  if (changes.length === 0) return null;
  const mode = (m: DeviceNetworkMode) => tn(m);
  const setting = (n: DeviceNetworkSetting) =>
    n.mode === null
      ? tn("follow")
      : n.mode === "allowlist" && n.hosts.length > 0
        ? t("withHosts", { value: mode(n.mode), hosts: n.hosts.join(", ") })
        : mode(n.mode);
  return (
    <ContentSection title={t("title")}>
      <ItemList label={t("title")}>
        {changes.map((c, i) => {
          const network = c.network;
          return (
            <ItemListItem
              // biome-ignore lint/suspicious/noArrayIndexKey: the changes have no id; the list is positional
              key={`${c.at}:${i}`}
              title={t("change", {
                setting: tn("title"),
                from: setting(network.from),
                to: setting(network.to),
              })}
              meta={
                <>
                  {formatDateTime(c.at, "full", zone)}
                  {" · "}
                  {c.by === null ? t("unknownBy") : <Person person={c.by} size={16} />}
                  {" · "}
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
