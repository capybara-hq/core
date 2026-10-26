"use client";

import {
  Button,
  Card,
  CodeBlock,
  type Column,
  DangerConfirm,
  DataTable,
  DetailPage,
  formatBytes,
  KeyValue,
  Skeleton,
  Stack,
  Text,
  useToast,
} from "@capybara-hq/design";
import { useParams } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { formatTime } from "../../../../../components/ApprovalCard";
import { FormError } from "../../../../../components/form-error";
import { OrgGate } from "../../../../../components/OrgGate";
import { useSession } from "../../../../../components/shell/session";
import { useRouter } from "../../../../../i18n/navigation";
import { ApiClientError } from "../../../../../lib/api";
import { canUpdateOrg } from "../../../../../lib/org-settings";
import {
  deleteSkill,
  getSkill,
  type SkillDetail,
  type SkillFile,
  type SkillVersion,
} from "../../../../../lib/skills";
import { useErrorMessage } from "../../../../../lib/use-error-message";
import { useLoad } from "../../../../../lib/use-load";

const TABS = ["content", "files", "versions"] as const;
type Tab = (typeof TABS)[number];

/**
 * `/[locale]/skills/[id]`：组织技能详情（DetailPage）：SKILL.md 正文（纯文本，不渲染 HTML / Markdown）、
 * 当前版本的文件、各版本；管理员可删除（输入技能名二次确认）。
 */
export default function SkillDetailPage() {
  const { id } = useParams<{ id: string }>();
  return <OrgGate>{(orgId) => <SkillInOrg orgId={orgId} id={id} />}</OrgGate>;
}

/** 技能属于打开它时的组织：切换组织后不再以新组织 + 旧技能 id 渲染。 */
function SkillInOrg({ orgId, id }: { orgId: string; id: string }) {
  const [openedIn] = useState(orgId);
  if (orgId !== openedIn) return null;
  return <SkillView orgId={orgId} id={id} />;
}

function SkillView({ orgId, id }: { orgId: string; id: string }) {
  const t = useTranslations("skills");
  const { state, reload } = useLoad(() => getSkill(orgId, id), [orgId, id]);
  const [tab, setTab] = useState<Tab>("content");
  const errorMessage = useErrorMessage();
  const skill = state.kind === "ready" ? state.data : undefined;
  return (
    <DetailPage
      header={{
        breadcrumb: [{ label: t("title"), href: "/skills" }],
        title: skill?.name ?? t("title"),
        ...(skill ? { count: t("version", { version: skill.currentVersion }) } : {}),
      }}
      tabs={{
        label: t("detail.tabsLabel"),
        items: TABS.map((x) => ({ id: x, label: t(`detail.tabs.${x}`) })),
        value: tab,
        onChange: (x) => setTab(x as Tab),
      }}
      inspectorTitle={t("detail.inspectorTitle")}
      inspector={skill ? <Inspector skill={skill} /> : undefined}
    >
      {state.kind === "loading" ? (
        <Skeleton rows={6} />
      ) : state.kind === "error" ? (
        <Stack gap={12}>
          <FormError message={errorMessage(new ApiClientError(0, state.code, ""))} />
          <Stack direction="row">
            <Button onClick={reload}>{t("detail.retry")}</Button>
          </Stack>
        </Stack>
      ) : tab === "content" ? (
        <ContentTab orgId={orgId} skill={state.data} />
      ) : tab === "files" ? (
        <FilesTab files={state.data.versions[0]?.files ?? []} />
      ) : (
        <VersionsTab versions={state.data.versions} />
      )}
    </DetailPage>
  );
}

function Inspector({ skill }: { skill: SkillDetail }) {
  const t = useTranslations("skills.detail");
  const tv = useTranslations("skills");
  const locale = useLocale();
  return (
    <Stack gap={12}>
      <KeyValue
        keyWidth="10ch"
        rows={[
          { k: t("name"), v: skill.name },
          { k: t("version"), v: tv("version", { version: skill.currentVersion }) },
          { k: t("files"), v: String(skill.versions[0]?.files.length ?? 0) },
          { k: t("updated"), v: formatTime(skill.updatedAt, locale) },
        ]}
      />
      <Stack gap={4}>
        <Text variant="small" tone="muted">
          {t("description")}
        </Text>
        <Text pre>{skill.description}</Text>
      </Stack>
    </Stack>
  );
}

/** SKILL.md 正文（纯文本）；管理员在下方有删除。 */
function ContentTab({ orgId, skill }: { orgId: string; skill: SkillDetail }) {
  const t = useTranslations("skills.detail");
  const router = useRouter();
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const { me } = useSession();
  const [confirm, setConfirm] = useState(false);
  return (
    <Stack gap={16}>
      {skill.body !== null ? (
        <CodeBlock language="SKILL.md" text={skill.body} />
      ) : (
        <Text tone="muted">{t("bodyUnavailable")}</Text>
      )}
      {canUpdateOrg(me) && (
        <>
          <Card tone="danger" title={t("dangerTitle")}>
            <Stack gap={12}>
              <Text tone="muted">{t("deleteHint")}</Text>
              <Stack direction="row">
                <Button variant="danger" onClick={() => setConfirm(true)}>
                  {t("delete")}
                </Button>
              </Stack>
            </Stack>
          </Card>
          <DangerConfirm
            open={confirm}
            onOpenChange={setConfirm}
            title={t("deleteTitle", { name: skill.name })}
            description={t("deleteHint")}
            confirmName={skill.name}
            confirmLabel={t("delete")}
            onConfirm={async () => {
              try {
                await deleteSkill(orgId, skill.id);
              } catch (e) {
                throw new Error(errorMessage(e));
              }
              setConfirm(false);
              toast.success(t("deleted", { name: skill.name }));
              router.push("/skills");
            }}
          />
        </>
      )}
    </Stack>
  );
}

function FilesTab({ files }: { files: SkillFile[] }) {
  const t = useTranslations("skills.detail");
  const columns: Column<SkillFile>[] = [
    { key: "path", header: t("columns.path"), cell: (f) => f.path },
    {
      key: "size",
      header: t("columns.size"),
      tone: "muted",
      width: 120,
      cell: (f) => formatBytes(f.size),
    },
  ];
  return (
    <DataTable<SkillFile>
      label={t("filesLabel")}
      columns={columns}
      rows={files}
      rowKey={(f) => f.path}
      state="ready"
      empty={{ title: t("filesLabel") }}
    />
  );
}

function VersionsTab({ versions }: { versions: SkillVersion[] }) {
  const t = useTranslations("skills.detail");
  const tv = useTranslations("skills");
  const locale = useLocale();
  const columns: Column<SkillVersion>[] = [
    {
      key: "version",
      header: t("columns.version"),
      width: 90,
      cell: (v) => tv("version", { version: v.version }),
    },
    {
      key: "description",
      header: t("columns.description"),
      cell: (v) => (
        <Text variant="small" truncate>
          {v.description}
        </Text>
      ),
    },
    {
      key: "files",
      header: t("columns.files"),
      tone: "muted",
      width: 90,
      cell: (v) => String(v.files.length),
    },
    {
      key: "created",
      header: t("columns.created"),
      tone: "muted",
      width: 160,
      cell: (v) => formatTime(v.createdAt, locale),
    },
  ];
  return (
    <DataTable<SkillVersion>
      label={t("versionsLabel")}
      columns={columns}
      rows={versions}
      rowKey={(v) => String(v.version)}
      state="ready"
      empty={{ title: t("versionsLabel") }}
    />
  );
}
