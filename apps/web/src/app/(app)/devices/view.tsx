"use client";

import { ListPage, ObjectCard } from "@capybara-hq/design";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { DeviceCreateDialog } from "../../../components/DeviceCreateDialog";
import { ErrorFrame } from "../../../components/ErrorFrame";
import { NoAccess } from "../../../components/NoAccess";
import { usePagePath } from "../../../components/shell/path";
import { useDeviceName } from "../../../components/use-device-name";
import {
  canCreateDevice,
  type Device,
  deviceCeilingMark,
  deviceState,
  providerLabel,
} from "../../../lib/devices";
import { labelLocale } from "../../../lib/extension-label";
import { devicesQuery } from "../../../lib/query/devices";
import { usePageQuery } from "../../../lib/query/page-query";
import { useWorkspace } from "../../../lib/query/workspace";
import NotFound from "../not-found";

/**
 * `/devices` (Devices): the person's devices as cards (the default shows as the personal device):
 * its provider's display name, state (running / paused / not started / files lost / unavailable; a
 * connected one online / offline) and the mode mark (auto / sandbox for a local device, open with
 * private networks blocked / allowlist for a cloud one); a card opens the device's page. New device
 * (offered
 * only when a device provider is on in the org) opens a dialog of provider cards with their
 * connection guides; without a provider the page says so, and the devices it still has are listed
 * as unavailable under a notice (they can be deleted). From the query cache (the
 * layout prefetched it on a first load).
 */
export default function DevicesView() {
  const ws = useWorkspace();
  if (ws.kind === "pending" || ws.kind === "noOrg") return null;
  if (ws.kind === "noAccess") return <NoAccess need={ws.need} />;
  return <Devices orgId={ws.orgId} />;
}

function Devices({ orgId }: { orgId: string }) {
  const scope = usePagePath("org");
  const t = useTranslations("devices");
  const [creating, setCreating] = useState(false);
  const list = usePageQuery(devicesQuery(orgId));
  if (list.kind === "notFound") return <NotFound />;
  if (list.kind === "error") return <ErrorFrame reset={list.retry} />;
  // New device needs a provider to create on: without one it is not offered
  const canCreate = list.kind === "ready" && canCreateDevice(list.data);
  const header = {
    path: [...scope, { label: "devices" }],
    title: t("title"),
    ...(canCreate && {
      actions: [
        { label: t("new"), variant: "primary" as const, onSelect: () => setCreating(true) },
      ],
    }),
    // While loading, whether New device is offered is not known yet: a placeholder holds its slot
    // so the action does not pop in after load
    ...(list.kind === "loading" && { loading: { actions: 1 } }),
  };
  const common = { variant: "cards" as const, listLabel: t("listLabel") };
  if (list.kind === "loading")
    return <ListPage header={header} {...common} loading={{ rows: 3 }} />;
  const items = list.data.items;
  // Without a provider the existing devices are still listed (as 不可用) and deletable; the
  // empty state is only for a list with nothing in it.
  const empty =
    items.length > 0
      ? undefined
      : list.data.providers.length === 0
        ? { text: t("noProviders.text"), hint: t("noProviders.hint") }
        : { text: t("empty") };
  const callout =
    items.length > 0 && list.data.providers.length === 0
      ? { tone: "warn" as const, children: t("noProviders.notice") }
      : undefined;
  return (
    <>
      <ListPage
        header={header}
        {...common}
        {...(empty ? { empty } : {})}
        {...(callout ? { callout } : {})}
      >
        {items.map((e) => (
          <DeviceCard key={e.id} device={e} />
        ))}
      </ListPage>
      {creating && (
        <DeviceCreateDialog
          orgId={orgId}
          providers={list.data.providers}
          defaultProvider={list.data.defaultProvider}
          onClose={() => setCreating(false)}
        />
      )}
    </>
  );
}

function DeviceCard({ device: e }: { device: Device }) {
  const t = useTranslations("devices");
  const nameOf = useDeviceName();
  const locale = labelLocale(useLocale());
  const state = deviceState(e);
  const mark = deviceCeilingMark(e);
  return (
    <ObjectCard
      avatar={{ icon: "cpu" }}
      title={nameOf(e)}
      href={`/devices/${encodeURIComponent(e.id)}`}
      description={e.provider === null ? t("none") : providerLabel(e, locale)}
      meta={[
        state === "filesLost" || state === "unavailable"
          ? { label: t(`state.${state}`), tone: "warn" as const }
          : t(`state.${state}`),
        // whether a call may run outside the sandbox there, neutral (no daily mode, no warn tone)
        t(`sandbox.mark.${mark}`),
      ]}
    />
  );
}
