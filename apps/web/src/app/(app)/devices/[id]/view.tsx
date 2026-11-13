"use client";

import {
  Badge,
  Button,
  ContentSection,
  DangerConfirm,
  DateTime,
  DetailPage,
  DeviceNameplate,
  type DeviceNameplateState,
  Dialog,
  Field,
  formatBytes,
  Input,
  KeyValue,
  Stack,
  Text,
  useToast,
} from "@capybara-hq/design";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { DeviceModeSection } from "../../../../components/DeviceModeSection";
import { ErrorFrame } from "../../../../components/ErrorFrame";
import { FormError } from "../../../../components/form-error";
import { NoAccess } from "../../../../components/NoAccess";
import { usePagePath } from "../../../../components/shell/path";
import { useDeviceName } from "../../../../components/use-device-name";
import { useRouter } from "../../../../i18n/navigation";
import { osLabel } from "../../../../lib/device-sign-in";
import {
  type Device,
  deleteDevice,
  deviceModeMark,
  deviceState,
  isDeviceName,
  renameDevice,
  resetDeviceFiles,
  revokeDeviceMachine,
} from "../../../../lib/devices";
import { extensionLabel, labelLocale } from "../../../../lib/extension-label";
import { deviceQuery } from "../../../../lib/query/devices";
import { keys } from "../../../../lib/query/keys";
import { useAppMutation } from "../../../../lib/query/mutation";
import { usePageQuery } from "../../../../lib/query/page-query";
import { useWorkspace } from "../../../../lib/query/workspace";
import { useErrorMessage } from "../../../../lib/use-error-message";
import NotFound from "../../not-found";

/**
 * `/devices/[id]`: one device (DetailPage, one centred column). Its head is the `DeviceNameplate`
 * band — name, origin, status light and mode mark on the left, program version and last seen on
 * the right — the page's one bright element; everything below is quiet. The facts keep 来源 /
 * 状态 / 创建时间 (a cloud device adds 提供方, 资源 and 网络, split into two rows: CPU · memory ·
 * disk, and 开放（挡内网） / 白名单), the files and suspension notes are each said once, and
 * `DeviceModeSection` holds the 自动 / 沙箱 scale, its network section (sandbox mode only) and the
 * recent changes. A local device adds its machine block (name, system, run mode, 断开这台机器) and
 * deleting it keeps the files on the machine. 重命名, 重建文件 (only when its files are lost, behind a
 * confirmation; a job, so the page then polls until the files are back) and 删除 (typing its name;
 * the files are deleted with it, a destructive item of the ⋯ menu; deleting 个人设备 says a new
 * empty one is created the next time one is needed). A local device never offers 重建文件 (the
 * kernel refuses it): its files-lost note tells the person to run `capybara-device logout`, then
 * `capybara-device login` on the machine. From the query cache (the layout prefetched it on a first
 * load); a device the kernel does not find is the not-found state.
 */
export default function DeviceView({ id }: { id: string }) {
  const ws = useWorkspace();
  if (ws.kind === "pending" || ws.kind === "noOrg") return null;
  if (ws.kind === "noAccess") return <NoAccess need={ws.need} />;
  return <DevicePage key={id} orgId={ws.orgId} id={id} />;
}

function DevicePage({ orgId, id }: { orgId: string; id: string }) {
  const scope = usePagePath("org");
  // 重建文件 is a job: after the request the page polls until the files are back
  const [resetting, setResetting] = useState(false);
  const read = usePageQuery({
    ...deviceQuery(orgId, id),
    refetchInterval: (q) => {
      const d = q.state.data?.device;
      return resetting && d !== undefined && (d.filesLost || d.mode.pendingFilesReset)
        ? RESET_POLL_MS
        : false;
    },
  });
  if (read.kind === "notFound") return <NotFound />;
  if (read.kind === "error") return <ErrorFrame reset={read.retry} />;
  if (read.kind === "loading") {
    return (
      <DetailPage
        header={{ path: [...scope, { label: "devices", href: "/devices" }], title: "" }}
        loading={{
          content: [
            { kind: "key-value", rows: 4, keyWidth: "10ch" },
            { kind: "lines", lines: 2 },
          ],
        }}
      />
    );
  }
  return (
    <Detail orgId={orgId} device={read.data.device} onResetScheduled={() => setResetting(true)} />
  );
}

/** How often the page reads the device while a file reset it requested is pending. */
const RESET_POLL_MS = 1500;

type Dialogs = "rename" | "reset" | "delete" | "revoke" | null;

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
  const tcm = useTranslations("common");
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState<Dialogs>(null);
  const name = useDeviceName()(e);
  const lang = labelLocale(useLocale());
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
  const revoke = useAppMutation({ fn: () => revokeDeviceMachine(orgId, e.id), invalidates });
  const { limits } = e;
  const local = e.source === "local";
  const npState: DeviceNameplateState =
    state === "running"
      ? "running"
      : state === "suspended"
        ? "suspended"
        : state === "online"
          ? "online"
          : "offline";
  const mark = deviceModeMark(e);
  return (
    <>
      <DetailPage
        header={{
          path: [...scope, { label: "devices", href: "/devices" }, { label: name }],
          title: name,
          actions: [
            { label: t("detail.rename"), variant: "default", onSelect: () => setOpen("rename") },
            ...((e.filesLost || e.mode.pendingFilesReset) && e.available && !local
              ? [
                  {
                    label: t("detail.resetFiles"),
                    variant: "default" as const,
                    onSelect: () => setOpen("reset"),
                  },
                ]
              : []),
            {
              label: tcm("moreActions"),
              menu: [
                { label: t("detail.delete"), danger: true, onSelect: () => setOpen("delete") },
              ],
            },
          ],
        }}
        facts={
          <DeviceNameplate
            name={name}
            origin={e.source}
            state={npState}
            version={local ? (e.machine?.programVersion ?? null) : null}
            lastSeen={local ? (e.machine?.lastSeenAt ?? null) : (e.instance?.lastUsedAt ?? null)}
            badge={<Badge tone={mark.tone}>{t(`mark.${mark.kind}`)}</Badge>}
            labels={{
              origin: { cloud: t("source.cloud"), local: t("source.local") },
              state: { [npState]: t(`state.${state}`) },
            }}
          />
        }
      >
        <Stack gap={16}>
          <KeyValue
            keyWidth="10ch"
            rows={[
              { k: t("detail.source"), v: t(`source.${e.source}`) },
              ...(local ? [] : [{ k: t("detail.provider"), v: e.provider ?? t("none") }]),
              { k: t("detail.state"), v: t(`state.${state}`) },
              ...(local
                ? []
                : [
                    {
                      k: t("detail.resources"),
                      v: t("detail.resourcesValue", {
                        cpu: limits.cpu,
                        memory: formatBytes(limits.memoryMb * 1024 * 1024),
                        disk: formatBytes(limits.diskMb * 1024 * 1024),
                      }),
                    },
                    {
                      k: t("detail.network"),
                      v: t(`networkKind.${e.mode.network.kind}`),
                    },
                  ]),
              { k: t("detail.created"), v: <DateTime value={e.createdAt} /> },
            ]}
          />
          {e.filesLost && (
            <Text variant="prose" tone="warn">
              {t(local ? "detail.localFilesLostNote" : "detail.filesLostNote")}
            </Text>
          )}
          {e.demotedFrom !== null && (
            <Text variant="prose" tone="muted">
              {t("detail.demotedNote", {
                provider: extensionLabel(
                  { name: e.demotedFrom.provider, displayName: e.demotedFrom.displayName },
                  lang,
                ),
              })}
            </Text>
          )}
          <Text variant="prose" tone="muted">
            {t(local ? "detail.localFilesNote" : "detail.filesAndSuspendNote")}
          </Text>
          <DeviceModeSection orgId={orgId} device={e} />
          {local && <MachineSection device={e} onRevoke={() => setOpen("revoke")} />}
        </Stack>
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
      {open === "revoke" && e.machine !== null && (
        <RevokeDialog
          machine={e.machine.name}
          pending={revoke.isPending}
          onClose={() => setOpen(null)}
          onRevoke={async () => {
            const machine = e.machine?.name ?? "";
            await revoke.mutateAsync(undefined);
            setOpen(null);
            toast.success(t("machine.revoked", { name: machine }));
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
            {t(
              local
                ? "detail.deleteLocalHint"
                : e.isDefault
                  ? "detail.deleteDefaultHint"
                  : "detail.deleteHint",
              { name },
            )}
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

/**
 * A local device's machine: name, system and how it runs commands (系统沙箱 / Docker), with
 * 断开这台机器; or the line saying none is connected. The program version and last seen are the
 * nameplate's alone, never repeated here.
 */
function MachineSection({ device: e, onRevoke }: { device: Device; onRevoke(): void }) {
  const t = useTranslations("devices");
  const m = e.machine;
  return (
    <ContentSection
      title={t("machine.title")}
      description={t("machine.description")}
      {...(m === null
        ? { empty: t("machine.none") }
        : {
            actions: (
              <Button density="dense" onClick={onRevoke}>
                {t("machine.revoke")}
              </Button>
            ),
          })}
    >
      {m !== null && (
        <KeyValue
          keyWidth="10ch"
          rows={[
            { k: t("machine.name"), v: m.name },
            { k: t("machine.os"), v: osLabel(m.os) },
            ...(m.mode !== null ? [{ k: t("machine.runMode"), v: t(`runMode.${m.mode}`) }] : []),
          ]}
        />
      )}
    </ContentSection>
  );
}

/**
 * 断开这台机器: its credential is revoked, so it asks first (a dangerous dialog that starts on
 * Cancel).
 */
function RevokeDialog({
  machine,
  pending,
  onClose,
  onRevoke,
}: {
  machine: string;
  pending: boolean;
  onClose(): void;
  onRevoke(): Promise<void>;
}) {
  const t = useTranslations("devices");
  const errorMessage = useErrorMessage();
  const [error, setError] = useState<string>();
  const submit = async () => {
    setError(undefined);
    try {
      await onRevoke();
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
      title={t("machine.revokeTitle", { name: machine })}
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
            {t("machine.revokeSubmit")}
          </Button>
        </>
      }
    >
      <Stack gap={12}>
        <Text variant="prose">{t("machine.revokeHint")}</Text>
        {error !== undefined && <FormError message={error} />}
      </Stack>
    </Dialog>
  );
}
