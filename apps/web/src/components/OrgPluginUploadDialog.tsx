"use client";

import {
  Button,
  Card,
  Dialog,
  FilePicker,
  Stack,
  SwitchField,
  Text,
  useToast,
  versionLabel,
} from "@capybara-hq/design";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { useRouter } from "../i18n/navigation";
import { ApiClientError, issueLines } from "../lib/api";
import {
  confirmOrgUpload,
  type OrgUploadReview,
  ownedBy,
  uploadOrgPluginPackage,
} from "../lib/catalog";
import { orgCatalogQuery, pluginChangeKeys } from "../lib/query/catalog";
import { retryOnMountOf } from "../lib/query/client";
import { keys } from "../lib/query/keys";
import { useAppMutation } from "../lib/query/mutation";
import type { Me } from "../lib/session";
import { uploadSkillZip } from "../lib/skills";
import { useErrorMessage } from "../lib/use-error-message";
import { useCatalogErrorLines } from "./CatalogParts";
import { FormError } from "./form-error";
import { PlatformUpdatePreviewBody } from "./PlatformUpdateDialog";
import { PluginReviewBody } from "./PluginReviewBody";

const isZip = (f: File) => /\.zip$/i.test(f.name);

/**
 * 上传插件包 on the workspace 插件 page (org admins; spec §14, rulings P3-7 to P3-12): pick a
 * `.tgz` (prepared at once: the kernel stages it for this org) or a single skill's `.zip` (sent to
 * the skill upload; the person lands on 技能). The review is the import's ({@link PluginReviewBody},
 * org mode: no scope picker and no pinned suggestions), with 范围：仅本组织, the 可共享 switch for a
 * new plugin (off by default; a new version keeps the plugin's setting), the notice when the
 * package carries an extension (it waits for the super admin), and the update preview when a new
 * version without an extension applies at once (one hash covers both). Confirm: a `pending`
 * outcome toasts 「已提交，等待超级管理员确认」.
 */
export function OrgPluginUploadDialog({
  orgId,
  me,
  onClose,
}: {
  orgId: string;
  me: Me;
  onClose(): void;
}) {
  const t = useTranslations("plugins.upload");
  const toast = useToast();
  const router = useRouter();
  const errorMessage = useErrorMessage();
  const catalogLines = useCatalogErrorLines();
  const [file, setFile] = useState<File | null>(null);
  const [staged, setStaged] = useState<OrgUploadReview | null>(null);
  const [shareable, setShareable] = useState(false);
  const [error, setError] = useState<{ message: string; extra: string[] }>();
  const cq = orgCatalogQuery(orgId);
  const items = useQuery({ ...cq, retryOnMount: retryOnMountOf(cq.queryKey) }).data?.items;
  // Preparing only stages the upload: nothing cached changes until it is confirmed
  const prepare = useAppMutation({
    fn: (f: File) => uploadOrgPluginPackage(orgId, f),
    invalidates: () => [],
  });
  const skill = useAppMutation({
    fn: (f: File) => uploadSkillZip(orgId, f),
    invalidates: (_, r) => [
      keys.org(orgId).skills(),
      keys.org(orgId).skill(r.skill.id),
      keys.org(orgId).componentsAll(),
    ],
  });
  // A confirmed upload is a new plugin or version of the org's (installed, updated or pending)
  const confirm = useAppMutation({
    fn: (v: { stagingId: string; reviewHash: string; shareable?: boolean }) =>
      confirmOrgUpload(orgId, v.stagingId, {
        reviewHash: v.reviewHash,
        ...(v.shareable !== undefined && { shareable: v.shareable }),
      }),
    invalidates: () => pluginChangeKeys(orgId),
  });
  const busy = prepare.isPending || skill.isPending || confirm.isPending;
  const problem = (e: unknown) => ({
    message: errorMessage(e),
    extra: [...issueLines(e), ...catalogLines(e)],
  });

  const pick = async (f: File | undefined) => {
    if (f === undefined || busy) return;
    setFile(f);
    setError(undefined);
    try {
      if (isZip(f)) {
        const r = await skill.mutateAsync(f);
        toast.success(t("skillUploaded", { name: r.skill.name }));
        onClose();
        router.push("/skills");
        return;
      }
      setStaged(await prepare.mutateAsync(f));
      setShareable(false);
    } catch (e) {
      setError(problem(e));
    }
  };

  const review = staged?.review ?? null;
  // A new version of a plugin the org already has keeps its 可共享 (the kernel sets it only on a
  // new item)
  const existing =
    review === null ? undefined : items?.find((i) => i.name === review.name && ownedBy(i, orgId));
  // Other orgs are named only by the kernel (the preview's `orgNames`) or the viewer's memberships
  const nameOrg = (id: string) => me.memberships.find((m) => m.orgId === id)?.name;
  // Confirm waits for the org's catalog: only then is a new version of an own plugin known (and
  // `shareable`, which the kernel sets only on a new plugin, left out)
  const known = items !== undefined;

  const submit = async () => {
    if (staged === null || !known) return;
    setError(undefined);
    try {
      const r = await confirm.mutateAsync({
        stagingId: staged.stagingId,
        reviewHash: staged.review.reviewHash,
        ...(existing === undefined && { shareable }),
      });
      const name = staged.review.name;
      toast.success(
        r.outcome === "pending"
          ? t("pending")
          : r.outcome === "updated"
            ? t("updated", { name, version: versionLabel(staged.review.version) })
            : t("installed", { name }),
      );
      onClose();
    } catch (e) {
      if (e instanceof ApiClientError && e.code === "plugin.review_stale") {
        setStaged(null);
        setError({ message: t("stale"), extra: [] });
      } else setError(problem(e));
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
      title={t("title")}
      size={640}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {t("cancel")}
          </Button>
          {staged !== null && (
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setStaged(null);
                setFile(null);
                setError(undefined);
              }}
            >
              {t("back")}
            </Button>
          )}
          <Button
            variant="primary"
            loading={confirm.isPending}
            disabled={staged === null || busy || !known}
            onClick={() => void submit()}
          >
            {t("confirm")}
          </Button>
        </>
      }
    >
      <Stack gap={16}>
        {staged === null ? (
          <FilePicker
            label={t("choose")}
            hint={t("chooseHint")}
            dropLabel={t("drop")}
            accept=".tgz,.zip,application/gzip,application/x-gzip,application/zip"
            disabled={busy}
            onFiles={(files) => void pick(files[0])}
          >
            {file !== null && busy && (
              <Text variant="small">{t("reading", { name: file.name })}</Text>
            )}
          </FilePicker>
        ) : (
          review !== null && (
            <>
              <Card>
                <Stack gap={8}>
                  <Text>{t("scope")}</Text>
                  {!known ? null : existing === undefined ? (
                    <SwitchField
                      label={t("shareable")}
                      checked={shareable}
                      onChange={setShareable}
                      disabled={busy}
                    />
                  ) : (
                    <Text variant="prose" tone="muted">
                      {t("newVersion", { name: review.name })}
                    </Text>
                  )}
                  {review.extension !== undefined && (
                    <Text variant="prose" tone="warn">
                      {t("extensionNotice")}
                    </Text>
                  )}
                </Stack>
              </Card>
              {staged.update !== null && (
                <Card title={t("updateTitle")}>
                  <PlatformUpdatePreviewBody
                    preview={staged.update}
                    orgName={nameOrg}
                    hideUnknown
                  />
                </Card>
              )}
              <PluginReviewBody review={review} />
            </>
          )
        )}
        {error !== undefined && <FormError message={error.message} extra={error.extra} />}
      </Stack>
    </Dialog>
  );
}
