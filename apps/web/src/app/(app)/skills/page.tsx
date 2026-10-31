"use client";

import {
  Button,
  Dialog,
  FileButton,
  FileDrop,
  ListPage,
  ObjectRow,
  Stack,
  Text,
  useToast,
} from "@capybara-hq/design";
import { useLocale, useTranslations } from "next-intl";
import { useRef, useState } from "react";
import { formatTime } from "../../../components/ApprovalCard";
import { FormError } from "../../../components/form-error";
import { RoleGate } from "../../../components/RoleGate";
import { usePagePath } from "../../../components/shell/path";
import { useSession } from "../../../components/shell/session";
import { issueLines } from "../../../lib/api";
import { canUpdateOrg } from "../../../lib/org-settings";
import { listSkills, precheckSkillZip, uploadSkillZip } from "../../../lib/skills";
import { useErrorMessage } from "../../../lib/use-error-message";
import { useLoad } from "../../../lib/use-load";

/**
 * `/skills`：组织技能库（object list）。成员可浏览，点一行进详情；管理员另有上传卡片
 * （选 / 拖入 .zip → 登记 → 直传 → 解包校验，同名技能新增版本）。
 */
export default function SkillsPage() {
  return <RoleGate min="member">{(orgId) => <Skills key={orgId} orgId={orgId} />}</RoleGate>;
}

function Skills({ orgId }: { orgId: string }) {
  const scope = usePagePath("org");
  const t = useTranslations("skills");
  const locale = useLocale();
  const { me } = useSession();
  const admin = canUpdateOrg(me);
  const [uploading, setUploading] = useState(false);
  const { state, reload } = useLoad(() => listSkills(orgId).then((r) => r.skills), [orgId]);
  const rows = state.kind === "ready" ? state.data : [];
  const empty =
    state.kind === "error"
      ? {
          icon: "circle-alert" as const,
          text: t("loadFailed"),
          action: { label: t("retry"), variant: "default" as const, onSelect: reload },
        }
      : state.kind === "ready" && rows.length === 0
        ? {
            text: t("empty"),
            ...(admin
              ? {
                  action: {
                    label: t("upload.open"),
                    variant: "primary" as const,
                    onSelect: () => setUploading(true),
                  },
                }
              : {}),
          }
        : undefined;
  return (
    <>
      <ListPage
        header={{
          path: [...scope, { label: "skills" }],
          title: t("title"),
          ...(admin
            ? {
                actions: [
                  {
                    label: t("upload.open"),
                    variant: "primary" as const,
                    onSelect: () => setUploading(true),
                  },
                ],
              }
            : {}),
        }}
        variant="objects"
        listLabel={t("listLabel")}
        loading={state.kind === "loading"}
        {...(empty ? { empty } : {})}
      >
        {rows.map((s) => (
          <ObjectRow
            key={s.id}
            mark={{ text: Array.from(s.name)[0] ?? "?" }}
            name={s.name}
            href={`/skills/${encodeURIComponent(s.id)}`}
            mono
            description={s.description}
            meta={`${t("version", { version: s.currentVersion })} · ${formatTime(s.updatedAt, locale)}`}
          />
        ))}
      </ListPage>
      {admin && (
        <Dialog
          open={uploading}
          onOpenChange={setUploading}
          title={t("upload.title")}
          size={640}
          footer={<Button onClick={() => setUploading(false)}>{t("upload.close")}</Button>}
        >
          <UploadCard
            orgId={orgId}
            onUploaded={() => {
              reload();
              setUploading(false);
            }}
          />
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
  const [busy, setBusy] = useState<{ name: string; progress: number }>();
  const [error, setError] = useState<{ message: string; extra: string[] }>();
  const [cancelled, setCancelled] = useState(false);
  /** 可重试的文件（上一次上传失败或被取消）。 */
  const [failed, setFailed] = useState<File>();
  const ctrl = useRef<AbortController | null>(null);

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
      const r = await uploadSkillZip(orgId, file, {
        signal: c.signal,
        onProgress: (progress) => setBusy({ name: file.name, progress }),
      });
      toast.success(
        r.created
          ? t("created", { name: r.skill.name })
          : t("versionCreated", { name: r.skill.name, version: r.version }),
      );
      onUploaded();
    } catch (e) {
      setFailed(file);
      if (c.signal.aborted) setCancelled(true);
      else setError({ message: errorMessage(e), extra: issueLines(e) });
    } finally {
      ctrl.current = null;
      setBusy(undefined);
    }
  }

  return (
    <FileDrop label={t("drop")} onFiles={(f) => void upload(f)} disabled={busy !== undefined}>
      <Stack gap={8}>
        <Text variant="small" tone="muted">
          {t("layoutHint")}
        </Text>
        <Text variant="small" tone="muted">
          {t("limits")}
        </Text>
        <Stack direction="row" gap={8} align="center">
          <FileButton
            label={t("choose")}
            accept=".zip,application/zip"
            onFiles={(f) => void upload(f)}
            disabled={busy !== undefined}
          />
          <Text variant="small" tone={busy !== undefined ? "ink" : "faint"}>
            {busy !== undefined
              ? t("uploading", { name: busy.name, percent: Math.round(busy.progress * 100) })
              : cancelled
                ? t("cancelled")
                : t("chooseHint")}
          </Text>
          {busy !== undefined && (
            <Button variant="ghost" onClick={() => ctrl.current?.abort()}>
              {t("cancel")}
            </Button>
          )}
          {busy === undefined && failed !== undefined && (
            <Button onClick={() => void upload([failed])}>{t("retry")}</Button>
          )}
        </Stack>
        {error !== undefined && <FormError message={error.message} extra={error.extra} />}
      </Stack>
    </FileDrop>
  );
}
