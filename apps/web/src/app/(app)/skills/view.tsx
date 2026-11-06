"use client";

import {
  Button,
  Dialog,
  FilePicker,
  formatDateTime,
  ListPage,
  ObjectRow,
  Stack,
  Text,
  useTimeZone,
  useToast,
} from "@capybara-hq/design";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useRef, useState } from "react";
import { useCatalogErrorLines, useOwnerLabel } from "../../../components/CatalogParts";
import { useComponentState, useComponentSwitch } from "../../../components/ComponentSwitch";
import { ErrorFrame } from "../../../components/ErrorFrame";
import { FormError } from "../../../components/form-error";
import { NoAccess } from "../../../components/NoAccess";
import { rowActions } from "../../../components/PluginSwitch";
import { SkillCreateDialog } from "../../../components/SkillCreateDialog";
import { usePagePath } from "../../../components/shell/path";
import { useSession } from "../../../components/shell/session";
import { ApiClientError, issueLines } from "../../../lib/api";
import { type OwnerSide, ownerSide } from "../../../lib/catalog";
import { usableRows } from "../../../lib/components";
import { canUpdateOrg } from "../../../lib/org-settings";
import { retryOnMountOf } from "../../../lib/query/client";
import { orgComponentsQuery } from "../../../lib/query/components";
import { keys } from "../../../lib/query/keys";
import { useAppMutation } from "../../../lib/query/mutation";
import { usePageQuery } from "../../../lib/query/page-query";
import { skillsQuery } from "../../../lib/query/skills";
import { useWorkspace } from "../../../lib/query/workspace";
import { precheckSkillZip, uploadSkillZip } from "../../../lib/skills";
import { useErrorMessage } from "../../../lib/use-error-message";
import NotFound from "../not-found";

/**
 * `/skills` (spec §9): the skills the org can use and the platform skills offered to it (object
 * list). Org-own rows carry 本组织, platform rows 平台 with their state in the org (已启用 · 平台统一 for
 * `all`, 已启用, 未启用, 插件未启用); org admins switch platform skills (启用, 停用 with the preview of the agents
 * using it), upload a .zip (a name a platform skill offered here already has is refused, rule 10)
 * or write one with 新建 (plugin scope phase 3). Members read the page. From the query cache (the
 * layout prefetched the library and the offered components on a first load); a switch or an upload
 * invalidates them.
 */
export default function SkillsView() {
  const ws = useWorkspace({ min: "member" });
  if (ws.kind === "pending" || ws.kind === "noOrg") return null;
  if (ws.kind === "noAccess") return <NoAccess need={ws.need} />;
  return <Skills orgId={ws.orgId} />;
}

function Skills({ orgId }: { orgId: string }) {
  const timeZone = useTimeZone();
  const scope = usePagePath("org");
  const t = useTranslations("skills");
  const tc = useTranslations("orgComponents");
  const { me } = useSession();
  const admin = canUpdateOrg(me);
  const [uploading, setUploading] = useState(false);
  const [creating, setCreating] = useState(false);
  const list = usePageQuery(skillsQuery(orgId));
  const cq = orgComponentsQuery(orgId, { kind: "skill" });
  const offered = useQuery({ ...cq, retryOnMount: retryOnMountOf(cq.queryKey) });
  const stateOf = useComponentState();
  const { actionsOf, dialog, error } = useComponentSwitch({ orgId, admin });
  const ownerLabel = useOwnerLabel(orgId);
  if (list.kind === "notFound") return <NotFound />;
  if (list.kind === "error") return <ErrorFrame reset={list.retry} />;
  const rows = list.kind === "ready" ? usableRows(list.data.skills, offered.data?.components) : [];
  const upload = {
    label: t("upload.open"),
    icon: "upload" as const,
    onSelect: () => setUploading(true),
  };
  // 新建 writes a skill from text (plugin scope phase 3), next to 上传
  const create = {
    label: t("create.open"),
    icon: "plus" as const,
    variant: "default" as const,
    onSelect: () => setCreating(true),
  };
  const empty =
    rows.length === 0
      ? {
          text: t("empty"),
          ...(admin
            ? {
                action: {
                  label: upload.label,
                  variant: "primary" as const,
                  onSelect: upload.onSelect,
                },
              }
            : {}),
        }
      : undefined;
  // Where it came from: its plugin, else whose upload it is (the same owner as the chip)
  const fromOf = (plugin: string | null | undefined, owner: OwnerSide) =>
    plugin
      ? tc("from.plugin", { plugin })
      : owner.kind === "platform"
        ? tc("from.platform")
        : owner.kind === "self"
          ? tc("from.org")
          : tc("from.orgNamed", { org: owner.name });
  return (
    <>
      <ListPage
        header={{
          path: [...scope, { label: "skills" }],
          title: t("title"),
          description: t("description"),
          ...(admin ? { actions: [create, { ...upload, variant: "primary" as const }] } : {}),
        }}
        variant="objects"
        listLabel={t("listLabel")}
        {...(error !== undefined
          ? {
              callout: {
                tone: "fail" as const,
                children: <FormError message={error.message} extra={error.extra} />,
              },
            }
          : offered.data === undefined && offered.error !== null
            ? // the offered components could not be read: the platform ones that are off and
              // their switches are missing until a retry
              {
                callout: {
                  tone: "warn" as const,
                  children: tc("listUnavailable"),
                  action: { label: tc("retry"), onSelect: () => void offered.refetch() },
                },
              }
            : {})}
        {...(list.kind === "loading" ? { loading: true } : empty ? { empty } : {})}
      >
        {rows.map((r) => {
          if (r.kind === "own") {
            const s = r.item;
            return (
              <ObjectRow
                key={s.id}
                mark={{ text: s.name }}
                name={s.name}
                href={`/skills/${encodeURIComponent(s.id)}`}
                mono
                chips={[{ label: tc("origin.org") }]}
                description={s.description}
                meta={[
                  fromOf(s.plugin, { kind: "self" }),
                  t("version", { version: s.currentVersion }),
                  formatDateTime(s.updatedAt, "full", timeZone),
                ]}
                state={{ label: tc("state.on"), tone: "ok" }}
              />
            );
          }
          const c = r.component;
          const s = r.item;
          // The owner from owner_org_id: 本组织 for the org's own upload, else the owner org or 平台
          const owner = c?.owner ?? s?.owner;
          const id = s?.id ?? c?.id ?? "";
          const name = s?.name ?? c?.name ?? "";
          const on = c?.on ?? s !== undefined;
          return (
            <ObjectRow
              key={id}
              mark={{ text: name }}
              name={name}
              mono
              {...(on && s !== undefined ? { href: `/skills/${encodeURIComponent(id)}` } : {})}
              chips={[{ label: ownerLabel(owner) }]}
              description={s?.description ?? c?.description ?? ""}
              meta={[
                fromOf(s?.plugin ?? c?.plugin, ownerSide(owner, orgId)),
                t("version", { version: s?.currentVersion ?? c?.version ?? "" }),
              ]}
              state={c !== undefined ? stateOf(c) : { label: tc("state.on"), tone: "ok" }}
              {...(c !== undefined ? rowActions(actionsOf(c)) : {})}
            />
          );
        })}
      </ListPage>
      {dialog}
      {admin && creating && <SkillCreateDialog orgId={orgId} onClose={() => setCreating(false)} />}
      {admin && (
        <Dialog
          open={uploading}
          onOpenChange={setUploading}
          title={t("upload.title")}
          size={640}
          footer={<Button onClick={() => setUploading(false)}>{t("upload.close")}</Button>}
        >
          <UploadCard orgId={orgId} onUploaded={() => setUploading(false)} />
        </Dialog>
      )}
    </>
  );
}

/**
 * 管理员的上传卡片：说明可接受的布局与上限；一次一个 .zip，上传中不能再选。上传中显示进度、可以取消；
 * 失败（不是前端预检拦下的）可以用同一个文件重试。
 */
function UploadCard({ orgId, onUploaded }: { orgId: string; onUploaded(): void }) {
  const t = useTranslations("skills.upload");
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const catalogLines = useCatalogErrorLines();
  const [busy, setBusy] = useState<{ name: string; progress: number }>();
  const [error, setError] = useState<{ message: string; extra: string[] }>();
  const [cancelled, setCancelled] = useState(false);
  /** 可重试的文件（上一次上传失败或被取消）。 */
  const [failed, setFailed] = useState<File>();
  const ctrl = useRef<AbortController | null>(null);
  // An upload adds a skill or a version: the list and that skill are read again.
  const send = useAppMutation({
    fn: (v: { file: File; signal: AbortSignal }) =>
      uploadSkillZip(orgId, v.file, {
        signal: v.signal,
        onProgress: (progress) => setBusy({ name: v.file.name, progress }),
      }),
    invalidates: (_, r) => [
      keys.org(orgId).skills(),
      keys.org(orgId).skill(r.skill.id),
      keys.org(orgId).componentsAll(),
    ],
  });

  async function upload(files: File[]) {
    const file = files[0];
    if (!file || busy !== undefined) return;
    const bad = precheckSkillZip(file);
    setFailed(undefined);
    setCancelled(false);
    if (bad !== null) {
      setError({ message: t(bad), extra: [] });
      return;
    }
    setError(undefined);
    setBusy({ name: file.name, progress: 0 });
    const c = new AbortController();
    ctrl.current = c;
    try {
      const r = await send.mutateAsync({ file, signal: c.signal });
      toast.success(
        r.created
          ? t("created", { name: r.skill.name })
          : t("versionCreated", { name: r.skill.name, version: r.version }),
      );
      onUploaded();
    } catch (e) {
      setFailed(file);
      if (c.signal.aborted) setCancelled(true);
      else if (e instanceof ApiClientError && e.code === "plugin.skill_conflict") {
        // Rule 10: the name is a platform skill's offered to the org; rename and upload again
        setFailed(undefined);
        setError({ message: t("nameTaken"), extra: catalogLines(e) });
      } else setError({ message: errorMessage(e), extra: issueLines(e) });
    } finally {
      ctrl.current = null;
      setBusy(undefined);
    }
  }

  const status =
    busy !== undefined
      ? t("uploading", { name: busy.name, percent: Math.round(busy.progress * 100) })
      : cancelled
        ? t("cancelled")
        : null;
  return (
    <Stack gap={12}>
      <Stack gap={8}>
        <Text variant="small" tone="muted">
          {t("layoutHint")}
        </Text>
        <Text variant="small" tone="muted">
          {t("limits")}
        </Text>
      </Stack>
      <FilePicker
        label={t("choose")}
        hint={t("chooseHint")}
        dropLabel={t("drop")}
        accept=".zip,application/zip"
        onFiles={(f) => void upload(f)}
        disabled={busy !== undefined}
      >
        {status !== null || failed !== undefined ? (
          <Stack direction="row" gap={8} align="center" wrap>
            {status !== null ? <Text variant="small">{status}</Text> : null}
            {busy !== undefined && (
              <Button variant="ghost" onClick={() => ctrl.current?.abort()}>
                {t("cancel")}
              </Button>
            )}
            {busy === undefined && failed !== undefined && (
              <Button onClick={() => void upload([failed])}>{t("retry")}</Button>
            )}
          </Stack>
        ) : null}
      </FilePicker>
      {error !== undefined && <FormError message={error.message} extra={error.extra} />}
    </Stack>
  );
}
