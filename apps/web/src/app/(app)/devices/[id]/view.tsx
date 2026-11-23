"use client";

import {
  Badge,
  Button,
  Callout,
  DangerConfirm,
  DangerZone,
  DangerZoneItem,
  DetailPage,
  DeviceNameplate,
  type DeviceNameplateState,
  Dialog,
  Field,
  Input,
  Stack,
  Text,
  useToast,
} from "@capybara-hq/design";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { DeviceNetworkSection } from "../../../../components/DeviceNetworkSection";
import { DeviceOverviewSection } from "../../../../components/DeviceOverviewSection";
import { DeviceProjectsSection } from "../../../../components/DeviceProjectsSection";
import { ErrorFrame } from "../../../../components/ErrorFrame";
import { FormError } from "../../../../components/form-error";
import { NoAccess } from "../../../../components/NoAccess";
import { usePagePath } from "../../../../components/shell/path";
import { useDeviceName } from "../../../../components/use-device-name";
import { useRouter } from "../../../../i18n/navigation";
import {
  type Device,
  deleteDevice,
  deviceCeilingMark,
  deviceState,
  isDeviceName,
  providerLabel,
  renameDevice,
  resetDeviceFiles,
  resetPollInterval,
} from "../../../../lib/devices";
import { labelLocale } from "../../../../lib/extension-label";
import { deviceQuery } from "../../../../lib/query/devices";
import { keys } from "../../../../lib/query/keys";
import { useAppMutation } from "../../../../lib/query/mutation";
import { usePageQuery } from "../../../../lib/query/page-query";
import { useWorkspace } from "../../../../lib/query/workspace";
import { useErrorMessage } from "../../../../lib/use-error-message";
import NotFound from "../../not-found";

/**
 * `/devices/[id]`: one device, the same page for every provider (device provider design §6.6;
 * DetailPage, one centred column). Its head is the `DeviceNameplate` band — name, the provider's
 * display name, status light and the sandbox mark on the left, program version (a dial-in
 * device's machine), last seen (the machine's, else the instance's last use) and creation time on
 * the right — the page's one bright element, and the page's title: the PageHeader is title-less,
 * so the name is said once (`titleHidden`). Tabs Overview (values: the provider's report, files,
 * recent changes, the danger zone), Network (the network setting) and Projects (the projects).
 * Rename, Rebuild files (only when the provider's report offers a reset and its files are lost, a
 * change waits for a file reset or its sandbox limits must be established again, said up front in
 * a callout; behind a confirmation; a job, so the page then polls until the files are back) and
 * Delete (typing its name; deleting the personal device says a new empty one is created the next
 * time one is needed). A provider not on in the org is one callout naming it.
 * From the query cache (the layout prefetched it on a first load); a device the kernel does not
 * find is the not-found state.
 */
export default function DeviceView({ id }: { id: string }) {
  const ws = useWorkspace();
  if (ws.kind === "pending" || ws.kind === "noOrg") return null;
  if (ws.kind === "noAccess") return <NoAccess need={ws.need} />;
  return <DevicePage key={id} orgId={ws.orgId} id={id} />;
}

function DevicePage({ orgId, id }: { orgId: string; id: string }) {
  const t = useTranslations("devices");
  const scope = usePagePath("org");
  // Rebuild files is a job: after the request the page polls until the files are back, within a deadline
  const [resetAt, setResetAt] = useState<number | null>(null);
  const read = usePageQuery({
    ...deviceQuery(orgId, id),
    refetchInterval: (q) => resetPollInterval(q.state.data?.device, resetAt, Date.now()),
  });
  if (read.kind === "notFound") return <NotFound />;
  if (read.kind === "error") return <ErrorFrame reset={read.retry} />;
  if (read.kind === "loading") {
    return (
      <DetailPage
        header={{
          path: [...scope, { label: "devices", href: "/devices" }],
          title: "",
          titleHidden: true,
          loading: { actions: 2 },
        }}
        tabs={{
          label: t("detail.tabsLabel"),
          items: tabItems(t),
          value: "overview",
          onChange: () => {},
        }}
        loading={{
          // the nameplate band stays where the loaded band lands
          band: true,
          content: [
            { kind: "key-value", rows: 4, keyWidth: "10ch" },
            { kind: "lines", lines: 2 },
          ],
        }}
      />
    );
  }
  return (
    <Detail
      orgId={orgId}
      device={read.data.device}
      onResetScheduled={() => setResetAt(Date.now())}
    />
  );
}

type Dialogs = "rename" | "reset" | "delete" | null;

type Tab = "overview" | "network" | "projects";
const TABS: readonly Tab[] = ["overview", "network", "projects"];
const TAB_LABEL = {
  overview: "detail.tabOverview",
  network: "detail.tabNetwork",
  projects: "detail.tabProjects",
} as const;
const tabItems = (t: ReturnType<typeof useTranslations<"devices">>) =>
  TABS.map((id) => ({ id, label: t(TAB_LABEL[id]) }));

function Detail({
  orgId,
  device: e,
  onResetScheduled,
}: {
  orgId: string;
  device: Device;
  onResetScheduled(): void;
}) {
  const scope = usePagePath("org");
  const t = useTranslations("devices");
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState<Dialogs>(null);
  const [tab, setTab] = useState<Tab>("overview");
  const lang = labelLocale(useLocale());
  const name = useDeviceName()(e);
  const state = deviceState(e);
  const invalidates = () => [keys.org(orgId).devices(), keys.org(orgId).device(e.id)];
  const rename = useAppMutation({
    fn: (next: string) => renameDevice(orgId, e.id, next),
    invalidates,
  });
  const reset = useAppMutation({ fn: () => resetDeviceFiles(orgId, e.id), invalidates });
  // A delete invalidates the list this page goes back to and forgets the device once the page
  // is left.
  const remove = useAppMutation({
    fn: () => deleteDevice(orgId, e.id),
    invalidates: () => [keys.org(orgId).devices()],
    forgetsOnLeave: () => [keys.org(orgId).device(e.id)],
  });
  const provider = providerLabel(e, lang) || t("none");
  const canReset =
    e.report?.reset === true &&
    e.available &&
    (e.filesLost || e.sandbox.pendingFilesReset || e.reconcileRequired);
  const npState: DeviceNameplateState =
    state === "running"
      ? "running"
      : state === "suspended"
        ? "suspended"
        : state === "online"
          ? "online"
          : "offline";
  const mark = deviceCeilingMark(e);
  return (
    <>
      <DetailPage
        header={{
          path: [...scope, { label: "devices", href: "/devices" }, { label: name }],
          title: name,
          // the nameplate is the page's visible head; the title stays an h1 for assistive tech
          titleHidden: true,
          actions: [
            { label: t("detail.rename"), variant: "default", onSelect: () => setOpen("rename") },
            ...(canReset
              ? [
                  {
                    label: t("detail.resetFiles"),
                    variant: "default" as const,
                    onSelect: () => setOpen("reset"),
                  },
                ]
              : []),
          ],
        }}
        tabs={{
          label: t("detail.tabsLabel"),
          items: tabItems(t),
          value: tab,
          onChange: (id) => setTab(TABS.find((x) => x === id) ?? "overview"),
        }}
        facts={
          <DeviceNameplate
            name={name}
            origin={provider}
            state={npState}
            version={e.machine?.programVersion ?? null}
            lastSeen={e.machine !== null ? e.machine.lastSeenAt : (e.instance?.lastUsedAt ?? null)}
            created={e.createdAt}
            badge={<Badge>{t(`sandbox.mark.${mark}`)}</Badge>}
            labels={{ state: { [npState]: t(`state.${state}`) } }}
          />
        }
      >
        {!e.available && <Callout tone="warn">{t("detail.providerOffNote", { provider })}</Callout>}
        {e.available && e.filesLost && (
          <Callout tone="warn">
            {t(e.report?.reset === true ? "detail.filesLostNote" : "detail.filesLostNoReset")}
          </Callout>
        )}
        {e.available && e.reconcileRequired && !e.filesLost && (
          <Callout tone="warn">{t("detail.reconcileNote")}</Callout>
        )}
        {tab === "overview" ? (
          <Stack gap={12}>
            <DeviceOverviewSection device={e} />
            <DangerZone title={t("danger.title")}>
              <DangerZoneItem
                title={t("detail.delete")}
                description={t(e.isDefault ? "detail.deleteDangerDefault" : "detail.deleteDanger", {
                  name,
                })}
                action={{ label: t("detail.delete"), onSelect: () => setOpen("delete") }}
              />
            </DangerZone>
          </Stack>
        ) : tab === "network" ? (
          <DeviceNetworkSection orgId={orgId} device={e} />
        ) : (
          <DeviceProjectsSection orgId={orgId} device={e} />
        )}
      </DetailPage>
      {open === "rename" && (
        <RenameDialog
          current={e.name ?? ""}
          pending={rename.isPending}
          onClose={() => setOpen(null)}
          onSave={async (next) => {
            await rename.mutateAsync(next);
            setOpen(null);
            toast.success(t("detail.renamed", { name: next }));
          }}
        />
      )}
      {open === "reset" && (
        <ResetDialog
          name={name}
          pending={reset.isPending}
          onClose={() => setOpen(null)}
          onReset={async () => {
            await reset.mutateAsync(undefined);
            setOpen(null);
            onResetScheduled();
            toast.success(t("detail.resetScheduled", { name }));
          }}
        />
      )}
      <DangerConfirm
        open={open === "delete"}
        onOpenChange={(o) => {
          if (!o) setOpen(null);
        }}
        title={t("detail.deleteTitle")}
        description={
          <Text variant="prose">
            {t(e.isDefault ? "detail.deleteDefaultHint" : "detail.deleteHint", { name })}
          </Text>
        }
        confirmName={name}
        confirmLabel={t("detail.delete")}
        onConfirm={async () => {
          await remove.mutateAsync(undefined);
          setOpen(null);
          toast.success(t("detail.deleted", { name }));
          router.push("/devices");
        }}
      />
    </>
  );
}

/**
 * 重命名: one field, prefilled with the current name (empty for the default); valid as at
 * creation.
 */
function RenameDialog({
  current,
  pending,
  onClose,
  onSave,
}: {
  current: string;
  pending: boolean;
  onClose(): void;
  onSave(name: string): Promise<void>;
}) {
  const t = useTranslations("devices");
  const errorMessage = useErrorMessage();
  const [name, setName] = useState(current);
  const [error, setError] = useState<string>();
  const valid = isDeviceName(name) && name.trim() !== current;
  const submit = async () => {
    if (!valid || pending) return;
    setError(undefined);
    try {
      await onSave(name.trim());
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
      title={t("detail.renameTitle")}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={pending}>
            {t("create.cancel")}
          </Button>
          <Button
            variant="primary"
            loading={pending}
            disabled={!valid || pending}
            onClick={() => void submit()}
          >
            {t("detail.renameSubmit")}
          </Button>
        </>
      }
    >
      <Stack gap={12}>
        <Field label={t("create.name")} required help={t("create.nameHelp")}>
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
    </Dialog>
  );
}

/** 重建文件: the workspace is wiped, so it asks first (a dangerous dialog that starts on Cancel). */
function ResetDialog({
  name,
  pending,
  onClose,
  onReset,
}: {
  name: string;
  pending: boolean;
  onClose(): void;
  onReset(): Promise<void>;
}) {
  const t = useTranslations("devices");
  const errorMessage = useErrorMessage();
  const [error, setError] = useState<string>();
  const submit = async () => {
    setError(undefined);
    try {
      await onReset();
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  return (
    <Dialog
      open
      danger
      initialFocus="cancel"
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
      title={t("detail.resetTitle", { name })}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={pending}>
            {t("create.cancel")}
          </Button>
          <Button
            variant="danger-solid"
            loading={pending}
            disabled={pending}
            onClick={() => void submit()}
          >
            {t("detail.resetSubmit")}
          </Button>
        </>
      }
    >
      <Stack gap={12}>
        <Text variant="prose">{t("detail.resetHint")}</Text>
        {error !== undefined && <FormError message={error} />}
      </Stack>
    </Dialog>
  );
}
