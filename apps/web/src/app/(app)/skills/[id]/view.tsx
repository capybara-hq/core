"use client";

import {
  Button,
  CodeBlock,
  type Column,
  DangerConfirm,
  DataTable,
  DateTime,
  DetailPage,
  formatBytes,
  KeyValue,
  Stack,
  SwitchField,
  Text,
  useToast,
} from "@capybara-hq/design";
import { useQuery } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { useOwnerLabel } from "../../../../components/CatalogParts";
import { ErrorFrame } from "../../../../components/ErrorFrame";
import { FormError } from "../../../../components/form-error";
import { NoAccess } from "../../../../components/NoAccess";
import { usePagePath } from "../../../../components/shell/path";
import { useSession } from "../../../../components/shell/session";
import { useRouter } from "../../../../i18n/navigation";
import { canUpdateOrg } from "../../../../lib/org-settings";
import { keys } from "../../../../lib/query/keys";
import { useAppMutation } from "../../../../lib/query/mutation";
import { usePageQuery } from "../../../../lib/query/page-query";
import { skillDeletePreviewQuery, skillQuery } from "../../../../lib/query/skills";
import { useWorkspace } from "../../../../lib/query/workspace";
import type { Me } from "../../../../lib/session";
import {
  deleteSkill,
  type SkillDeletePreview,
  type SkillDetail,
  type SkillFile,
  type SkillVersion,
  setSkillShareable,
} from "../../../../lib/skills";
import { useErrorMessage } from "../../../../lib/use-error-message";
import NotFound from "../../not-found";

const TABS = ["content", "files", "versions"] as const;
type Tab = (typeof TABS)[number];

/**
 * `/skills/[id]`: an org skill's detail (DetailPage, one centred column): the full description
 * first (line breaks kept), the facts as a KeyValue, then the tabs: the SKILL.md body (plain text, no HTML or
 * Markdown rendering), the current version's files, the versions. Org admins delete the org's own
 * skill from the head's ⋯ menu (typing its name; the confirmation says what the delete does: one
 * another org uses is transferred to the platform, ruling P3-19). The org's own skill carries the
 * 可共享 switch under the facts (plugin scope phase 3; members see it disabled). A platform skill on in the org (or
 * an org copy linked to one, which the kernel answers with the platform skill) is read only: the
 * org switches it on the 技能 page. From the query cache (the layout prefetched it on a first load);
 * a skill the kernel does not find is the not-found state.
 */
export default function SkillView({ skillId }: { skillId: string }) {
  const ws = useWorkspace({ min: "member" });
  if (ws.kind === "pending" || ws.kind === "noOrg") return null;
  if (ws.kind === "noAccess") return <NoAccess need={ws.need} />;
  return <Skill key={skillId} orgId={ws.orgId} skillId={skillId} />;
}

function Skill({ orgId, skillId }: { orgId: string; skillId: string }) {
  const scope = usePagePath("org");
  const t = useTranslations("skills");
  const { me } = useSession();
  const [tab, setTab] = useState<Tab>("content");
  const read = usePageQuery(skillQuery(orgId, skillId));
  const tabs = {
    label: t("detail.tabsLabel"),
    items: TABS.map((x) => ({ id: x, label: t(`detail.tabs.${x}`) })),
    value: tab,
    onChange: (x: string) => setTab(x as Tab),
  };
  if (read.kind === "notFound") return <NotFound />;
  if (read.kind === "error") return <ErrorFrame reset={read.retry} />;
  if (read.kind === "loading") {
    return (
      <DetailPage
        header={{ path: [...scope, { label: "skills", href: "/skills" }], title: "" }}
        tabs={tabs}
        // One column: the facts (a KeyValue), then the content tab's SKILL.md body
        loading={{
          content: [
            { kind: "key-value", rows: 5, keyWidth: "10ch" },
            { kind: "lines", lines: 12 },
          ],
        }}
      />
    );
  }
  return <SkillDetailView orgId={orgId} skill={read.data} tabs={tabs} tab={tab} me={me} />;
}

/**
 * The loaded skill in one centred column (no inspector): the full description first, the
 * facts as a KeyValue (and the 可共享 switch of the org's own skill), then the tab. Org admins
 * delete the org's own skill from the head's ⋯ menu (a destructive item).
 */
function SkillDetailView({
  orgId,
  skill,
  tabs,
  tab,
  me,
}: {
  orgId: string;
  skill: SkillDetail;
  tabs: Parameters<typeof DetailPage>[0]["tabs"];
  tab: Tab;
  me: Me;
}) {
  const scope = usePagePath("org");
  const t = useTranslations("skills");
  const tcm = useTranslations("common");
  const td = useTranslations("plugins.delete");
  const router = useRouter();
  const toast = useToast();
  const previewKey = keys.org(orgId).skillDeletePreview(skill.id);
  const [confirm, setConfirm] = useState(false);
  // A delete invalidates the library (the list this page goes back to) and forgets the skill once
  // this page is left.
  const remove = useAppMutation({
    fn: () => deleteSkill(orgId, skill.id),
    invalidates: () => [keys.org(orgId).skills()],
    forgetsOnLeave: () => [keys.org(orgId).skill(skill.id), previewKey],
  });
  const deletable = canUpdateOrg(me) && skill.origin !== "platform";
  return (
    <>
      <DetailPage
        header={{
          path: [...scope, { label: "skills", href: "/skills" }, { label: skill.name }],
          title: skill.name,
          count: t("version", { version: skill.currentVersion }),
          ...(deletable
            ? {
                actions: [
                  {
                    label: tcm("moreActions"),
                    menu: [
                      { label: t("detail.delete"), danger: true, onSelect: () => setConfirm(true) },
                    ],
                  },
                ],
              }
            : {}),
        }}
        tabs={tabs}
      >
        <Stack gap={16}>
          {/* The full description, line breaks kept, first in the column */}
          {skill.description !== "" && (
            <Text variant="prose" tone="muted" pre>
              {skill.description}
            </Text>
          )}
          <Facts orgId={orgId} skill={skill} />
          {tab === "content" ? (
            <ContentTab skill={skill} />
          ) : tab === "files" ? (
            <FilesTab files={skill.versions[0]?.files ?? []} />
          ) : (
            <VersionsTab versions={skill.versions} />
          )}
        </Stack>
      </DetailPage>
      {deletable && confirm && (
        <SkillDeleteDialog
          orgId={orgId}
          skill={skill}
          onClose={() => setConfirm(false)}
          onDelete={async (outcome) => {
            await remove.mutateAsync(undefined);
            setConfirm(false);
            toast.success(
              outcome === "transferred"
                ? td("doneTransferred", { name: skill.name })
                : t("detail.deleted", { name: skill.name }),
            );
            router.push("/skills");
          }}
        />
      )}
    </>
  );
}

/**
 * 可共享 is offered on the org's own org-scope skill only (ruling P3-6): not on a platform skill (or
 * a copy linked to one), and not on a plugin's skill, which is shared with its plugin.
 */
const ownSkill = (s: SkillDetail) =>
  s.origin !== "platform" && s.scope === "org" && (s.plugin ?? null) === null;

/** The skill's facts, a KeyValue in the single column; the org's own skill's 可共享 switch under it. */
function Facts({ orgId, skill }: { orgId: string; skill: SkillDetail }) {
  const t = useTranslations("skills.detail");
  const tv = useTranslations("skills");
  const ownerLabel = useOwnerLabel(orgId);
  return (
    <Stack gap={12}>
      <KeyValue
        keyWidth="10ch"
        rows={[
          {
            k: t("owner"),
            // A platform skill's owner from owner_org_id: 本组织 for the org's own upload
            v: skill.origin === "platform" ? ownerLabel(skill.owner) : t("ownerOrg"),
          },
          ...(skill.plugin ? [{ k: t("plugin"), v: skill.plugin }] : []),
          { k: t("version"), v: tv("version", { version: skill.currentVersion }) },
          { k: t("files"), v: String(skill.versions[0]?.files.length ?? 0) },
          { k: t("updated"), v: <DateTime value={skill.updatedAt} /> },
        ]}
      />
      {ownSkill(skill) && <ShareSwitch orgId={orgId} skill={skill} />}
    </Stack>
  );
}

/** The 可共享 switch of the org's own skill (org admins switch it; members read it). */
function ShareSwitch({ orgId, skill }: { orgId: string; skill: SkillDetail }) {
  const t = useTranslations("skills.detail");
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const { me } = useSession();
  const [error, setError] = useState<string>();
  // 可共享 changes the skill and what the platform may offer: the skill, the library and the
  // offered components read again
  const share = useAppMutation({
    fn: (shareable: boolean) => setSkillShareable(orgId, skill.id, shareable),
    invalidates: () => [
      keys.org(orgId).skill(skill.id),
      keys.org(orgId).skills(),
      keys.org(orgId).componentsAll(),
    ],
  });
  const toggle = async (next: boolean) => {
    setError(undefined);
    try {
      await share.mutateAsync(next);
      toast.success(
        next ? t("shareOn", { name: skill.name }) : t("shareOff", { name: skill.name }),
      );
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  return (
    <Stack gap={4}>
      <SwitchField
        label={t("shareable")}
        checked={skill.shareable === true}
        onChange={(next) => void toggle(next)}
        disabled={!canUpdateOrg(me) || share.isPending}
      />
      <Text variant="small" tone="muted">
        {t("shareableHelp")}
      </Text>
      {error !== undefined && <FormError message={error} />}
    </Stack>
  );
}

/** The SKILL.md body (plain text); a platform skill says the org switches it on the 技能 page. */
function ContentTab({ skill }: { skill: SkillDetail }) {
  const t = useTranslations("skills.detail");
  return (
    <Stack gap={16}>
      {skill.body !== null ? (
        <CodeBlock language="SKILL.md" text={skill.body} />
      ) : (
        <Text tone="muted">{t("bodyUnavailable")}</Text>
      )}
      {skill.origin === "platform" && (
        <Text variant="small" tone="muted">
          {t("platformHint")}
        </Text>
      )}
    </Stack>
  );
}

/**
 * The delete confirmation (ruling P3-19): it reads what the delete does first and says it (one
 * another org uses is transferred to the platform, the orgs named; the org's agents that lose it).
 * 删除技能 stays disabled until that preview is read (`confirmDisabled`) and the name typed; a
 * preview that cannot be read says so with 重试. The outcome passed to `onDelete` is the preview the
 * person saw.
 */
function SkillDeleteDialog({
  orgId,
  skill,
  onClose,
  onDelete,
}: {
  orgId: string;
  skill: SkillDetail;
  onClose(): void;
  onDelete(outcome: SkillDeletePreview["outcome"]): Promise<void>;
}) {
  const t = useTranslations("skills.detail");
  const td = useTranslations("plugins.delete");
  const sep = useLocale() === "zh" ? "、" : ", ";
  const errorMessage = useErrorMessage();
  const preview = useQuery({
    ...skillDeletePreviewQuery(orgId, skill.id),
    refetchOnMount: "always",
  });
  // the preview shown, unless a read is in flight (a retry): only a settled preview is confirmed
  const p = preview.isFetching ? undefined : preview.data;
  return (
    <DangerConfirm
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={t("deleteTitle", { name: skill.name })}
      confirmName={skill.name}
      confirmLabel={t("delete")}
      confirmDisabled={p === undefined}
      onConfirm={async () => {
        if (p === undefined) return;
        try {
          await onDelete(p.outcome);
        } catch (e) {
          // DangerConfirm shows the message: the localized one, never the kernel's English
          throw new Error(errorMessage(e));
        }
      }}
      description={
        <Stack gap={12}>
          {p !== undefined && p.outcome === "transferred" && (
            <Text variant="prose" tone="warn">
              {td("transferred", { orgs: p.orgs.map((o) => o.name).join(sep) })}
            </Text>
          )}
          <Text variant="prose">{t("deleteHint")}</Text>
          {p === undefined && !preview.isError && (
            <Text variant="small" tone="muted">
              {td("loading")}
            </Text>
          )}
          {preview.isError && !preview.isFetching && (
            <Stack direction="row" gap={8} align="center" wrap>
              <Text variant="small" tone="fail">
                {t("previewFailed")}
              </Text>
              <Button onClick={() => void preview.refetch()}>{t("previewRetry")}</Button>
            </Stack>
          )}
          {p !== undefined && p.agents.length > 0 && (
            <Stack gap={4}>
              <Text variant="small" tone="warn">
                {td("agents")}
              </Text>
              {p.agents.map((a) => (
                <Text key={a.id} variant="small">
                  {`· ${a.name}`}
                </Text>
              ))}
            </Stack>
          )}
        </Stack>
      }
    />
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
      cell: (v) => <DateTime value={v.createdAt} />,
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
