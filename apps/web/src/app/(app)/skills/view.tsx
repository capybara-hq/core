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
  useToast,
} from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { useRef, useState, useTransition } from "react";
import { FormError } from "../../../components/form-error";
import { usePagePath } from "../../../components/shell/path";
import { useSession } from "../../../components/shell/session";
import { useRouter } from "../../../i18n/navigation";
import { issueLines } from "../../../lib/api";
import { canUpdateOrg } from "../../../lib/org-settings";
import { precheckSkillZip, type SkillSummary, uploadSkillZip } from "../../../lib/skills";
import { useErrorMessage } from "../../../lib/use-error-message";

/**
 * `/skills`：组织技能库（object list）。成员可浏览，点一行进详情；管理员另有上传卡片
 * （选 / 拖入 .zip → 登记 → 直传 → 解包校验，同名技能新增版本）。The list is read on the server
 * (`page.tsx`); an upload re-renders it there.
 */
export default function SkillsView({ orgId, initial }: { orgId: string; initial: SkillSummary[] }) {
  const scope = usePagePath("org");
  const t = useTranslations("skills");
  const { me } = useSession();
  const admin = canUpdateOrg(me);
  const [uploading, setUploading] = useState(false);
  const router = useRouter();
  const [, startTransition] = useTransition();
  const rows = initial;
  const empty =
    rows.length === 0
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
        {...(empty ? { empty } : {})}
      >
        {rows.map((s) => (
          <ObjectRow
            key={s.id}
            mark={{ text: s.name }}
            name={s.name}
            href={`/skills/${encodeURIComponent(s.id)}`}
            mono
            description={s.description}
            meta={`${t("version", { version: s.currentVersion })} · ${formatDateTime(s.updatedAt)}`}
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
              startTransition(() => router.refresh());
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
