"use client";

import {
  Button,
  EmptyState,
  FileBrowser,
  FileTree,
  formatBytes,
  LoadFailed,
  Segmented,
  Skeleton,
  Stack,
  Text,
} from "@capybara-hq/design";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import { SkillPreviewEmbed } from "../../../../components/extension-ui/SkillPreviewEmbed";
import { FilePreviewBody } from "../../../../components/file-preview/FilePreviewBody";
import { useOpenDownload } from "../../../../components/SessionFilePreview";
import { ApiClientError } from "../../../../lib/api";
import { type FileSource, sourceUrls } from "../../../../lib/file-source";
import { skillFilesQuery } from "../../../../lib/query/skills";
import {
  SKILL_MAIN_FILE,
  type SkillDetail,
  type SkillFileEntry,
  skillFileName,
} from "../../../../lib/skills";
import { useErrorMessage } from "../../../../lib/use-error-message";

/** SKILL.md leads the tree, before the folders. */
const PINNED = [SKILL_MAIN_FILE];

/** The Files tab's place in the address: the file (`?file=`) and the version (`?version=`). */
export type FilesAddress = {
  /** "" = none chosen (SKILL.md is shown). */
  file: string;
  /** null = the current version. */
  version: number | null;
  /** Shows a file of the version (written with history.replaceState, never a push). */
  selectFile(path: string): void;
  /** Back to the tree (the compact form): drops `?file=`. */
  back(): void;
  /** Opens the Files tab at a version (null: the current one), SKILL.md selected. */
  openVersion(version: number | null): void;
};

/**
 * The Files tab (skill file browser design): a version's files as a `FileTree` beside the selected
 * file's preview in a `FileBrowser`, the preview being the shared `FilePreviewBody` with the skill
 * file as its source (built-ins with no plugin, `file-preview@1` previewers that take it, the card
 * with Download for the rest). SKILL.md is selected unless `?file=` names another file; at compact
 * the tree is the page and a chosen file is pushed (back drops `?file=`). A version other than
 * the current one says so, with the way back to the current one; a version the skill does not
 * have says that instead of offering Retry.
 */
export function FilesTab({
  orgId,
  skill,
  address,
}: {
  orgId: string;
  skill: SkillDetail;
  address: FilesAddress;
}) {
  const t = useTranslations("skills.detail");
  const errorMessage = useErrorMessage();
  const list = useQuery(skillFilesQuery(orgId, skill.id, address.version));
  const files = list.data?.files;
  const tree = useMemo(
    () => (files ?? []).map((f) => ({ path: f.path, size: formatBytes(f.size) })),
    [files],
  );
  if (list.data === undefined) {
    // a ?version= the skill does not have: say so and offer the current version, not Retry
    if (
      address.version !== null &&
      list.error instanceof ApiClientError &&
      list.error.code === "skill.file_not_found"
    ) {
      return (
        <EmptyState
          size="panel"
          text={t("versionMissing", { version: address.version })}
          action={{
            label: t("showCurrent"),
            variant: "default",
            onSelect: () => address.openVersion(null),
          }}
        />
      );
    }
    if (list.error !== null) {
      return (
        <LoadFailed
          name={t("fileList")}
          reason={errorMessage(list.error)}
          onRetry={() => void list.refetch()}
        />
      );
    }
    return <Skeleton rows={6} />;
  }
  const { version } = list.data;
  const selected = address.file !== "" ? address.file : SKILL_MAIN_FILE;
  const file = list.data.files.find((f) => f.path === selected);
  return (
    <Stack gap={12}>
      <Stack direction="row" gap={8} align="center" wrap>
        <Text variant="small" tone="muted">
          {version === skill.currentVersion
            ? t("filesOfCurrent", { version })
            : t("filesOfVersion", { version })}
        </Text>
        {version !== skill.currentVersion && (
          <Button density="dense" onClick={() => address.openVersion(null)}>
            {t("showCurrent")}
          </Button>
        )}
      </Stack>
      <FileBrowser
        label={t("browserLabel")}
        open={address.file !== ""}
        onBack={address.back}
        selected={selected}
        tree={
          <FileTree
            label={t("treeLabel")}
            files={tree}
            selected={selected}
            onSelect={address.selectFile}
            pinned={PINNED}
          />
        }
      >
        {file === undefined ? (
          <Text tone="muted">{t("fileMissing")}</Text>
        ) : (
          <SkillFilePreview
            key={`${version}/${file.path}`}
            orgId={orgId}
            skillId={skill.id}
            version={version}
            file={file}
          />
        )}
      </FileBrowser>
    </Stack>
  );
}

/**
 * One skill file in the browser: its path, the previewer switch when more than one takes it,
 * Download, then the body; loading and failures (a file changed since the listing: 409
 * `skill.file_changed`) as the body reports them, with the file card under a failure.
 */
function SkillFilePreview({
  orgId,
  skillId,
  version,
  file,
}: {
  orgId: string;
  skillId: string;
  version: number;
  file: SkillFileEntry;
}) {
  const t = useTranslations("skills.detail");
  const tc = useTranslations("chatPanel");
  const openDownload = useOpenDownload();
  const [picked, setPicked] = useState<string | null>(null);
  const source: FileSource = {
    kind: "skill",
    orgId,
    skillId,
    version,
    file: { ...file, name: skillFileName(file.path) },
  };
  const download = () => openDownload(sourceUrls(source).download);
  return (
    <FilePreviewBody
      source={source}
      previewer={picked}
      onDownload={download}
      embed={(h) => (
        <SkillPreviewEmbed orgId={orgId} skill={{ skillId, version, path: file.path }} host={h} />
      )}
      frame={({ state, failure, onRetry, children, previewers, previewer }) => (
        <Stack gap={12}>
          <Stack direction="row" gap={8} align="center" justify="between" wrap>
            <Text truncate title={file.path}>
              {file.path}
            </Text>
            <Stack direction="row" gap={8} align="center">
              {previewers.length > 1 && previewer !== undefined && (
                <Segmented
                  label={t("previewersLabel")}
                  density="dense"
                  options={previewers.map((p) => ({ value: p.id, label: p.title }))}
                  value={previewer}
                  onChange={setPicked}
                />
              )}
              <Button density="dense" onClick={download}>
                {tc("download")}
              </Button>
            </Stack>
          </Stack>
          {state === "loading" ? (
            <Skeleton rows={8} />
          ) : state === "failed" ? (
            <>
              <LoadFailed
                name={failure?.name ?? file.path}
                {...(failure?.reason !== undefined ? { reason: failure.reason } : {})}
                {...(onRetry ? { onRetry } : {})}
              />
              {children}
            </>
          ) : (
            children
          )}
        </Stack>
      )}
    />
  );
}
