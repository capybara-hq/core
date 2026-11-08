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
  KeyValue,
  Stack,
  Text,
  useToast,
  versionLabel,
} from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { ErrorFrame } from "../../../../components/ErrorFrame";
import { FormError } from "../../../../components/form-error";
import { NoAccess } from "../../../../components/NoAccess";
import { usePagePath } from "../../../../components/shell/path";
import { useRouter } from "../../../../i18n/navigation";
import { osLabel } from "../../../../lib/devices";
import {
  deleteEnvironment,
  type Environment,
  environmentState,
  isEnvironmentName,
  renameEnvironment,
  resetEnvironmentFiles,
  revokeEnvironmentMachine,
} from "../../../../lib/environments";
import { environmentQuery } from "../../../../lib/query/environments";
import { keys } from "../../../../lib/query/keys";
import { useAppMutation } from "../../../../lib/query/mutation";
import { usePageQuery } from "../../../../lib/query/page-query";
import { useWorkspace } from "../../../../lib/query/workspace";
import { useErrorMessage } from "../../../../lib/use-error-message";
import NotFound from "../../not-found";

/**
 * `/environments/[id]`: one environment (DetailPage, one centred column): source, provider, state,
 * whether sessions are isolated, the limits, and the two things a person must know (files stay
 * until the environment is deleted; suspending ends running processes). A connected one has no
 * provider, limits or those notes: its machine section (name, system, mode, program version, last
 * seen) with 断开这台机器 instead, and deleting it keeps the files on the machine. 重命名, 重建文件
 * (only when its files are lost, behind a confirmation; a job, so the page then polls until the
 * files are back) and 删除 (typing its name; the files are deleted with it, a destructive item of
 * the ⋯ menu; deleting 个人环境 says a new empty one is created the next time one is needed). A
 * connected environment never offers 重建文件 (the kernel refuses it): its files-lost note tells
 * the person to run `capybara-device logout`, then `capybara-device login` on the machine. From
 * the query cache (the layout prefetched it on a first load); an environment the kernel does not
 * find is the not-found state.
 */
export default function EnvironmentView({ id }: { id: string }) {
  const ws = useWorkspace();
  if (ws.kind === "pending" || ws.kind === "noOrg") return null;
  if (ws.kind === "noAccess") return <NoAccess need={ws.need} />;
  return <EnvironmentPage key={id} orgId={ws.orgId} id={id} />;
}

function EnvironmentPage({ orgId, id }: { orgId: string; id: string }) {
  const scope = usePagePath("org");
  const t = useTranslations("environments");
  // 重建文件 is a job: after the request the page polls until the files are back
  const [resetting, setResetting] = useState(false);
  const read = usePageQuery({
    ...environmentQuery(orgId, id),
    refetchInterval: (q) =>
      resetting && q.state.data?.environment.filesLost ? RESET_POLL_MS : false,
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
        header={{ path: [...scope, { label: "environments", href: "/environments" }], title: "" }}
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
      environment={read.data.environment}
      tabs={tabs}
      onResetScheduled={() => setResetting(true)}
    />
  );
}

/** How often the page reads the environment while a file reset it requested is pending. */
const RESET_POLL_MS = 1500;

type Dialogs = "rename" | "reset" | "delete" | "revoke" | null;

function Detail({
  orgId,
  environment: e,
  tabs,
  onResetScheduled,
}: {
  orgId: string;
  environment: Environment;
  tabs: Parameters<typeof DetailPage>[0]["tabs"];
  onResetScheduled(): void;
}) {
  const scope = usePagePath("org");
  const t = useTranslations("environments");
  const tcm = useTranslations("common");
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState<Dialogs>(null);
  const name = e.name ?? t("personal");
  const state = environmentState(e);
  const invalidates = () => [keys.org(orgId).environments(), keys.org(orgId).environment(e.id)];
  const rename = useAppMutation({
    fn: (next: string) => renameEnvironment(orgId, e.id, next),
    invalidates,
  });
  const reset = useAppMutation({ fn: () => resetEnvironmentFiles(orgId, e.id), invalidates });
  // A delete invalidates the list this page goes back to and forgets the environment once the page
  // is left.
  const remove = useAppMutation({
    fn: () => deleteEnvironment(orgId, e.id),
    invalidates: () => [keys.org(orgId).environments()],
    forgetsOnLeave: () => [keys.org(orgId).environment(e.id)],
  });
  const revoke = useAppMutation({ fn: () => revokeEnvironmentMachine(orgId, e.id), invalidates });
  const { limits } = e;
  const device = e.source === "device";
  return (
    <>
      <DetailPage
        header={{
          path: [...scope, { label: "environments", href: "/environments" }, { label: name }],
          title: name,
          actions: [
            { label: t("detail.rename"), variant: "default", onSelect: () => setOpen("rename") },
            ...(e.filesLost && e.available && !device
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
              ...(device ? [] : [{ k: t("detail.provider"), v: e.provider ?? t("none") }]),
              { k: t("detail.state"), v: t(`state.${state}`) },
              {
                k: t("detail.isolation"),
                v: t(e.sessionIsolation ? "isolation.isolated" : "isolation.shared"),
              },
              ...(device
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
              {t(device ? "detail.deviceFilesLostNote" : "detail.filesLostNote")}
            </Text>
          )}
          {device ? (
            <Text variant="prose" tone="muted">
              {t("detail.deviceFilesNote")}
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
          {device && <MachineSection environment={e} onRevoke={() => setOpen("revoke")} />}
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
              device
                ? "detail.deleteDeviceHint"
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
          router.push("/environments");
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
  const t = useTranslations("environments");
  const errorMessage = useErrorMessage();
  const [name, setName] = useState(current);
  const [error, setError] = useState<string>();
  const valid = isEnvironmentName(name) && name.trim() !== current;
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
  const t = useTranslations("environments");
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
 * A device environment's machine: name, system, how it runs commands (系统沙箱 / Docker), program
 * version and when it was last seen, with 断开这台机器; or the line saying none is connected.
 */
function MachineSection({
  environment: e,
  onRevoke,
}: {
  environment: Environment;
  onRevoke(): void;
}) {
  const t = useTranslations("environments");
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
  const t = useTranslations("environments");
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
