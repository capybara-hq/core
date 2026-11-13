"use client";

import {
  Button,
  ContentSection,
  DangerConfirm,
  DateTime,
  DetailPage,
  Dialog,
  Field,
  formatBytes,
  Input,
  ItemList,
  KeyValue,
  Stack,
  Text,
  useToast,
  versionLabel,
} from "@capybara-hq/design";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { ApiErrorDetail } from "../../../../components/ApiErrorDetail";
import { DeviceSandboxSection } from "../../../../components/DeviceSandboxSection";
import { ErrorFrame } from "../../../../components/ErrorFrame";
import { FormError } from "../../../../components/form-error";
import { NoAccess } from "../../../../components/NoAccess";
import { usePagePath } from "../../../../components/shell/path";
import { useDeviceName } from "../../../../components/use-device-name";
import { useRouter } from "../../../../i18n/navigation";
import { osLabel } from "../../../../lib/device-sign-in";
import {
  type Device,
  type DevicePolicyPatch,
  deleteDevice,
  deviceState,
  isDeviceName,
  renameDevice,
  resetDeviceFiles,
  revokeDeviceMachine,
  updateDevicePolicy,
} from "../../../../lib/devices";
import { extensionLabel, labelLocale } from "../../../../lib/extension-label";
import { allowHostProblem, normalizeHost } from "../../../../lib/network-hosts";
import { deviceQuery } from "../../../../lib/query/devices";
import { keys } from "../../../../lib/query/keys";
import { useAppMutation } from "../../../../lib/query/mutation";
import { usePageQuery } from "../../../../lib/query/page-query";
import { useWorkspace } from "../../../../lib/query/workspace";
import { useErrorMessage } from "../../../../lib/use-error-message";
import NotFound from "../../not-found";

/**
 * `/devices/[id]`: one device (DetailPage, one centred column): source, provider, state,
 * whether sessions are isolated, the limits, and the two things a person must know (files stay
 * until the device is deleted; suspending ends running processes). A local one has no
 * provider, limits or those notes: its machine section (name, system, mode, program version, last
 * seen) with 断开这台机器 instead, and deleting it keeps the files on the machine. 重命名, 重建文件
 * (only when its files are lost, behind a confirmation; a job, so the page then polls until the
 * files are back) and 删除 (typing its name; the files are deleted with it, a destructive item of
 * the ⋯ menu; deleting 个人设备 says a new empty one is created the next time one is needed). A
 * local device never offers 重建文件 (the kernel refuses it): its files-lost note tells
 * the person to run `capybara-device logout`, then `capybara-device login` on the machine. Every
 * device has the 沙箱级别 section (`DeviceSandboxSection`); a cloud device whose new level waits for
 * a file reset offers 重建文件 too. From
 * the query cache (the layout prefetched it on a first load); a device the kernel does not
 * find is the not-found state.
 */
export default function DeviceView({ id }: { id: string }) {
  const ws = useWorkspace();
  if (ws.kind === "pending" || ws.kind === "noOrg") return null;
  if (ws.kind === "noAccess") return <NoAccess need={ws.need} />;
  return <DevicePage key={id} orgId={ws.orgId} id={id} />;
}

function DevicePage({ orgId, id }: { orgId: string; id: string }) {
  const scope = usePagePath("org");
  const t = useTranslations("devices");
  // 重建文件 is a job: after the request the page polls until the files are back
  const [resetting, setResetting] = useState(false);
  const read = usePageQuery({
    ...deviceQuery(orgId, id),
    refetchInterval: (q) => {
      const d = q.state.data?.device;
      return resetting && (d?.filesLost || d?.sandbox?.pendingFilesReset) ? RESET_POLL_MS : false;
    },
  });
  const tabs = {
    label: t("detail.tabsLabel"),
    items: [{ id: "summary", label: t("detail.tabs.summary") }],
    value: "summary",
  };
  if (read.kind === "notFound") return <NotFound />;
  if (read.kind === "error") return <ErrorFrame reset={read.retry} />;
  if (read.kind === "loading") {
    return (
      <DetailPage
        header={{ path: [...scope, { label: "devices", href: "/devices" }], title: "" }}
        tabs={tabs}
        loading={{
          content: [
            { kind: "key-value", rows: 6, keyWidth: "10ch" },
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
      tabs={tabs}
      onResetScheduled={() => setResetting(true)}
    />
  );
}

/** How often the page reads the device while a file reset it requested is pending. */
const RESET_POLL_MS = 1500;

type Dialogs = "rename" | "reset" | "delete" | "revoke" | null;

function Detail({
  orgId,
  device: e,
  tabs,
  onResetScheduled,
}: {
  orgId: string;
  device: Device;
  tabs: Parameters<typeof DetailPage>[0]["tabs"];
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
  return (
    <>
      <DetailPage
        header={{
          path: [...scope, { label: "devices", href: "/devices" }, { label: name }],
          title: name,
          actions: [
            { label: t("detail.rename"), variant: "default", onSelect: () => setOpen("rename") },
            ...((e.filesLost || e.sandbox?.pendingFilesReset === true) && e.available && !local
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
        tabs={tabs}
      >
        <Stack gap={16}>
          <KeyValue
            keyWidth="10ch"
            rows={[
              { k: t("detail.source"), v: t(`source.${e.source}`) },
              ...(local ? [] : [{ k: t("detail.provider"), v: e.provider ?? t("none") }]),
              { k: t("detail.state"), v: t(`state.${state}`) },
              {
                k: t("detail.isolation"),
                v: t(e.sessionIsolation ? "isolation.isolated" : "isolation.shared"),
              },
              ...(local
                ? []
                : [
                    {
                      k: t("detail.limits"),
                      v: t("detail.limitsValue", {
                        cpu: limits.cpu,
                        memory: formatBytes(limits.memoryMb * 1024 * 1024),
                        disk: formatBytes(limits.diskMb * 1024 * 1024),
                        egress: t(`egress.${limits.egress}`),
                      }),
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
          {local ? (
            <Text variant="prose" tone="muted">
              {t("detail.localFilesNote")}
            </Text>
          ) : (
            <>
              <Text variant="prose" tone="muted">
                {t("detail.filesNote")}
              </Text>
              <Text variant="prose" tone="muted">
                {t("detail.suspendNote")}
              </Text>
            </>
          )}
          <DeviceSandboxSection orgId={orgId} device={e} />
          {local && <MachineSection device={e} onRevoke={() => setOpen("revoke")} />}
          {local && e.machine !== null && e.network != null && (
            <NetworkSection orgId={orgId} device={e} />
          )}
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
 * A local device's machine: name, system, how it runs commands (系统沙箱 / Docker), program
 * version and when it was last seen, with 断开这台机器; or the line saying none is connected.
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
            ...(m.mode !== null ? [{ k: t("machine.mode"), v: t(`mode.${m.mode}`) }] : []),
            ...(m.programVersion !== null
              ? [{ k: t("machine.programVersion"), v: versionLabel(m.programVersion) }]
              : []),
            {
              k: t("machine.lastSeen"),
              v: m.lastSeenAt === null ? t("machine.never") : <DateTime value={m.lastSeenAt} />,
            },
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

/**
 * A local device's network (owner only: the page is the owner's; network ask-to-allow spec §7):
 * the machine's local allowlist with 移除 each (narrowing, always accepted), an add field that
 * takes `*.` wildcards and whether the machine takes changes from the platform (`remoteGrants`, set
 * only on the machine: off disables the widening controls with the command to run there). The
 * level (formerly 「不限网络」) and the recent changes are the 沙箱级别 section's. A program without
 * the `policyOpId` feature must be upgraded first; a Docker-mode machine can't limit single domains.
 * Each change is sent to the machine, which answers with the policy as written.
 */
function NetworkSection({ orgId, device: e }: { orgId: string; device: Device }) {
  const t = useTranslations("devices.network");
  const toast = useToast();
  const [host, setHost] = useState("");
  const [hostError, setHostError] = useState<string>();
  const [failure, setFailure] = useState<unknown>(null);
  const change = useAppMutation({
    fn: (patch: DevicePolicyPatch) => updateDevicePolicy(orgId, e.id, patch),
    invalidates: () => [keys.org(orgId).devices(), keys.org(orgId).device(e.id)],
  });
  const network = e.network;
  if (network == null) return null;
  const policy = network.policy;
  const canApply = network.features.includes("policyOpId");
  const docker = e.machine?.mode === "docker";
  const remoteOff = policy?.remoteGrants === "off";
  // widening (add) needs the machine to take it; narrowing is always sent
  const canWiden = canApply && policy !== null && !remoteOff && !docker;
  const pending = change.isPending;

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
  const add = async () => {
    const h = normalizeHost(host);
    const problem = allowHostProblem(h, { wildcard: true });
    if (problem !== null) {
      setHostError(t("hostInvalid"));
      return;
    }
    if (policy?.allowedDomains.includes(h)) {
      setHostError(t("hostPresent"));
      return;
    }
    setHostError(undefined);
    if (await send({ add: [h] }, t("added", { host: h }))) setHost("");
  };

  return (
    <ContentSection title={t("title")} description={t("description")}>
      <Stack gap={12}>
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
            <KeyValue
              keyWidth="14ch"
              rows={[
                {
                  k: t("remoteGrants"),
                  v: t(remoteOff ? "remoteGrantsOff" : "remoteGrantsOwner"),
                },
              ]}
            />
            <Text variant="small" tone="muted">
              {t(remoteOff ? "remoteGrantsOffHint" : "remoteGrantsHint")}
            </Text>
            <ItemList
              label={t("domains")}
              empty={t("domainsEmpty")}
              rows={policy.allowedDomains.map((h) => ({
                id: h,
                title: h,
                ...(canApply
                  ? {
                      actions: (
                        <Button
                          density="dense"
                          disabled={pending}
                          aria-label={t("removeLabel", { host: h })}
                          onClick={() => void send({ remove: [h] }, t("removed", { host: h }))}
                        >
                          {t("remove")}
                        </Button>
                      ),
                    }
                  : {}),
              }))}
            />
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
        {failure !== null && <ApiErrorDetail error={failure} open />}
      </Stack>
    </ContentSection>
  );
}
