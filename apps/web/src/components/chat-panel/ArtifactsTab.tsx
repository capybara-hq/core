"use client";

import { Card, CodeBlock, formatBytes, KeyValue, Stack, Text } from "@capybara-hq/design";
import { useLocale, useTranslations } from "next-intl";
import { ApiClientError } from "../../lib/api";
import {
  type Artifact,
  artifactDownloadUrl,
  getArtifactPreview,
  isImageArtifact,
  isTextArtifact,
} from "../../lib/artifacts";
import { attachmentTypeLabel } from "../../lib/attachments";
import { useErrorMessage } from "../../lib/use-error-message";
import { useLoad } from "../../lib/use-load";
import { formatTime } from "../ApprovalCard";
import { SessionFilePreview } from "../SessionFilePreview";

/** 文本产物的开头若干行：纯文本（CodeBlock，不当 HTML 渲染）；失败时只提示，下载照常。 */
function TextPreview({
  orgId,
  conversationId,
  artifactId,
}: {
  orgId: string;
  conversationId: string;
  artifactId: string;
}) {
  const t = useTranslations("chatPanel");
  const errorMessage = useErrorMessage();
  const { state } = useLoad(
    () => getArtifactPreview(orgId, conversationId, artifactId),
    [orgId, conversationId, artifactId],
  );
  if (state.kind === "loading") return null;
  if (state.kind === "error") {
    return (
      <Text variant="small" tone="warn">
        {errorMessage(new ApiClientError(0, state.code, state.code))}
      </Text>
    );
  }
  return (
    <Stack gap={4}>
      <CodeBlock text={state.data.text} />
      {state.data.truncated && (
        <Text variant="small" tone="faint">
          {t("previewTruncated")}
        </Text>
      )}
    </Stack>
  );
}

/**
 * 产物标签：本对话里 agent 交付的文件（从日志的 `artifact_created` 重建，最新的在前）。
 * 每项显示名称、类型、大小、交付时间与下载链接；位图有缩略图（`?inline=1`），文本类显示开头若干行。
 */
export function ArtifactsTab({
  orgId,
  conversationId,
  artifacts,
}: {
  orgId: string;
  conversationId: string;
  artifacts: Artifact[];
}) {
  const t = useTranslations("chatPanel");
  const locale = useLocale();
  return (
    <Stack gap={12}>
      {artifacts.map((a) => (
        // biome-ignore lint/a11y/useSemanticElements: 一个产物的分组；apps/web 不能写样式，用 role=group
        <div key={a.id} role="group" aria-label={a.name}>
          <Card title={a.name}>
            <Stack gap={8}>
              {isImageArtifact(a.contentType) && (
                <SessionFilePreview
                  kind="image"
                  name={a.name}
                  href={artifactDownloadUrl(orgId, conversationId, a.id, { inline: true })}
                />
              )}
              {isTextArtifact(a.contentType) && (
                <TextPreview orgId={orgId} conversationId={conversationId} artifactId={a.id} />
              )}
              <KeyValue
                keyWidth="6ch"
                rows={[
                  { k: t("artifactType"), v: attachmentTypeLabel(a.contentType) },
                  { k: t("artifactSize"), v: formatBytes(a.size) },
                  { k: t("artifactCreated"), v: formatTime(a.createdAt, locale) },
                ]}
              />
              <SessionFilePreview
                kind="file"
                name={a.name}
                href={artifactDownloadUrl(orgId, conversationId, a.id)}
                meta={t("download")}
              />
            </Stack>
          </Card>
        </div>
      ))}
    </Stack>
  );
}
