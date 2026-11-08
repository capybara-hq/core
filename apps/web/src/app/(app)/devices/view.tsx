"use client";

import { ListPage, ObjectCard } from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { DeviceCreateDialog } from "../../../components/DeviceCreateDialog";
import { ErrorFrame } from "../../../components/ErrorFrame";
import { NoAccess } from "../../../components/NoAccess";
import { usePagePath } from "../../../components/shell/path";
import { type Device, deviceState } from "../../../lib/devices";
import { devicesQuery } from "../../../lib/query/devices";
import { usePageQuery } from "../../../lib/query/page-query";
import { useWorkspace } from "../../../lib/query/workspace";
import NotFound from "../not-found";

/**
 * `/devices` (设备): the person's devices as cards (the default shows as 个人设备): source
 * (云端设备 / 本地设备), state (运行中 / 已暂停 / 未启动 / 文件已丢失 / 不可用; a connected one 在线 /
 * 离线) and whether sessions are isolated; a card opens the device's page. 新建设备 opens a
 * dialog (a cloud sandbox or a connected device); without a sandbox provider the page says the
 * platform has no cloud sandbox and the dialog only connects a device; the cloud devices it
 * still has are listed as 不可用 under a notice (they can be deleted). From the query cache (the
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
  // 新建设备 is always there: without a cloud sandbox it still connects a device
  const header = {
    path: [...scope, { label: "devices" }],
    title: t("title"),
    actions: [{ label: t("new"), variant: "primary" as const, onSelect: () => setCreating(true) }],
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
      : !list.data.cloudAvailable
        ? { text: t("noCloud.text"), hint: t("noCloud.hint") }
        : { text: t("empty") };
  const callout =
    items.length > 0 && !list.data.cloudAvailable
      ? { tone: "warn" as const, children: t("noCloud.notice") }
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
          cloudAvailable={list.data.cloudAvailable}
          onClose={() => setCreating(false)}
        />
      )}
    </>
  );
}

function DeviceCard({ device: e }: { device: Device }) {
  const t = useTranslations("devices");
  const state = deviceState(e);
  return (
    <ObjectCard
      avatar={{ icon: "cpu" }}
      title={e.name ?? t("personal")}
      href={`/devices/${encodeURIComponent(e.id)}`}
      description={t(`source.${e.source}`)}
      meta={[
        state === "filesLost" || state === "unavailable"
          ? { label: t(`state.${state}`), tone: "warn" as const }
          : t(`state.${state}`),
        t(e.sessionIsolation ? "isolation.isolated" : "isolation.shared"),
      ]}
    />
  );
}
