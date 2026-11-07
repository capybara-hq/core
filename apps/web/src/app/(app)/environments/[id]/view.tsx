"use client";

import {
  Button,
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
} from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { ErrorFrame } from "../../../../components/ErrorFrame";
import { FormError } from "../../../../components/form-error";
import { NoAccess } from "../../../../components/NoAccess";
import { usePagePath } from "../../../../components/shell/path";
import { useRouter } from "../../../../i18n/navigation";
import {
  deleteEnvironment,
  type Environment,
  environmentState,
  isEnvironmentName,
  renameEnvironment,
  resetEnvironmentFiles,
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
 * until the environment is deleted; suspending ends running processes). 重命名, 重建文件 (only
 * when its files are lost, behind a confirmation) and 删除 (typing its name; the files are deleted
 * with it, a destructive item of the ⋯ menu). From the query cache (the layout prefetched it on
 * a first load); an environment the kernel does not find is the not-found state.
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
  const read = usePageQuery(environmentQuery(orgId, id));
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
  return <Detail orgId={orgId} environment={read.data.environment} tabs={tabs} />;
}

type Dialogs = "rename" | "reset" | "delete" | null;

function Detail({
  orgId,
  environment: e,
  tabs,
}: {
  orgId: string;
  environment: Environment;
  tabs: Parameters<typeof DetailPage>[0]["tabs"];
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
  const { limits } = e;
  return (
    <>
      <DetailPage
        header={{
          path: [...scope, { label: "environments", href: "/environments" }, { label: name }],
          title: name,
          actions: [
            { label: t("detail.rename"), variant: "default", onSelect: () => setOpen("rename") },
            ...(e.filesLost
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
              { k: t("detail.provider"), v: e.provider ?? t("none") },
              { k: t("detail.state"), v: t(`state.${state}`) },
              {
                k: t("detail.isolation"),
                v: t(e.sessionIsolation ? "isolation.isolated" : "isolation.shared"),
              },
              {
                k: t("detail.limits"),
                v: t("detail.limitsValue", {
                  cpu: limits.cpu,
                  memory: formatBytes(limits.memoryMb * 1024 * 1024),
                  disk: formatBytes(limits.diskMb * 1024 * 1024),
                  egress: t(`egress.${limits.egress}`),
                }),
              },
              { k: t("detail.created"), v: <DateTime value={e.createdAt} /> },
            ]}
          />
          {e.filesLost && (
            <Text variant="prose" tone="warn">
              {t("detail.filesLostNote")}
            </Text>
          )}
          <Text variant="prose" tone="muted">
            {t("detail.filesNote")}
          </Text>
          <Text variant="prose" tone="muted">
            {t("detail.suspendNote")}
          </Text>
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
            toast.success(t("detail.resetDone", { name }));
          }}
        />
      )}
      <DangerConfirm
        open={open === "delete"}
        onOpenChange={(o) => {
          if (!o) setOpen(null);
        }}
        title={t("detail.deleteTitle")}
        description={<Text variant="prose">{t("detail.deleteHint", { name })}</Text>}
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

/** 重命名: one field, prefilled with the current name (empty for the default); valid as at creation. */
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
