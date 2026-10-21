"use client";

import {
  Button,
  Card,
  type Column,
  DataTable,
  FileButton,
  FileDrop,
  ListPage,
  Stack,
  Text,
  useToast,
} from "@capybara-hq/design";
import { useLocale, useTranslations } from "next-intl";
import { useRef, useState } from "react";
import { formatTime } from "../../../../components/ApprovalCard";
import { FormError } from "../../../../components/form-error";
import { OrgGate } from "../../../../components/OrgGate";
import { useSession } from "../../../../components/shell/session";
import { useRouter } from "../../../../i18n/navigation";
import { issueLines } from "../../../../lib/api";
import { canUpdateOrg } from "../../../../lib/org-settings";
import {
  listSkills,
  precheckSkillZip,
  type SkillSummary,
  uploadSkillZip,
} from "../../../../lib/skills";
import { useErrorMessage } from "../../../../lib/use-error-message";
import { useLoad } from "../../../../lib/use-load";

/**
 * `/[locale]/skills`：组织技能库（ListPage + DataTable）。成员可浏览，点一行进详情；管理员另有上传卡片
 * （选 / 拖入 .zip → 登记 → 直传 → 解包校验，同名技能新增版本）。
 */
export default function SkillsPage() {
  return <OrgGate>{(orgId) => <Skills key={orgId} orgId={orgId} />}</OrgGate>;
}

function Skills({ orgId }: { orgId: string }) {
  const t = useTranslations("skills");
  const locale = useLocale();
  const router = useRouter();
  const { me } = useSession();
  const admin = canUpdateOrg(me);
  const { state, reload } = useLoad(() => listSkills(orgId).then((r) => r.skills), [orgId]);
  const rows = state.kind === "ready" ? state.data : [];
  const columns: Column<SkillSummary>[] = [
    { key: "name", header: t("columns.name"), cell: (s) => s.name },
    {
      key: "description",
      header: t("columns.description"),
      tone: "muted",
      cell: (s) => (
        <Text variant="small" tone="muted" truncate>
          {s.description}
        </Text>
      ),
    },
    {
      key: "version",
      header: t("columns.version"),
      width: 90,
      cell: (s) => t("version", { version: s.currentVersion }),
    },
    {
      key: "updated",
      header: t("columns.updated"),
      tone: "muted",
      width: 160,
      cell: (s) => formatTime(s.updatedAt, locale),
    },
  ];
  return (
    <ListPage
      header={{
        title: t("title"),
        count: state.kind === "ready" ? String(rows.length) : undefined,
      }}
    >
      <Stack gap={16}>
        {admin && <UploadCard orgId={orgId} onUploaded={reload} />}
        <DataTable<SkillSummary>
          label={t("listLabel")}
          columns={columns}
          rows={rows}
          rowKey={(s) => s.id}
          rowLabel={(s) => s.name}
          onOpen={(s) => router.push(`/skills/${encodeURIComponent(s.id)}`)}
          state={state.kind === "ready" ? "ready" : state.kind}
          {...(state.kind === "error" ? { error: { code: state.code, onRetry: reload } } : {})}
          empty={{ title: t("empty"), hint: t("emptyHint") }}
        />
      </Stack>
    </ListPage>
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
      <Card title={t("title")}>
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
      </Card>
    </FileDrop>
  );
}
