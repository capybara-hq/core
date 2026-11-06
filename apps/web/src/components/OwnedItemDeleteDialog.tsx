"use client";

import { Button, Dialog, Stack, Text, useToast } from "@capybara-hq/design";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiClientError } from "../lib/api";
import { deleteOwned, type OwnedDeletePreview, previewOwnedDelete } from "../lib/catalog";
import { pluginChangeKeysButDetail } from "../lib/query/catalog";
import { keys } from "../lib/query/keys";
import { useAppMutation } from "../lib/query/mutation";
import { useErrorMessage } from "../lib/use-error-message";
import { FormError } from "./form-error";

/**
 * 删除 of a plugin the org uploaded (spec §14, ruling P3-19): the preview first (nothing written),
 * then the delete with its `previewHash`. Another org still using it: 「其他组织仍在使用，删除后将
 * 转为平台所有：{orgs}」 (it is transferred to the platform); otherwise 「删除后不可恢复」. The org's
 * agents that lose it are listed. A preview that changed meanwhile (409 `catalog.preview_stale`)
 * is read again and said before confirming. On success the plugin's detail is forgotten when the
 * page is left and `onDeleted` runs.
 */
export function OwnedItemDeleteDialog({
  orgId,
  itemId,
  name,
  onClose,
  onDeleted,
}: {
  orgId: string;
  itemId: string;
  name: string;
  onClose(): void;
  onDeleted(): void;
}) {
  const t = useTranslations("plugins.delete");
  const locale = useLocale();
  const sep = locale === "zh" ? "、" : ", ";
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const [preview, setPreview] = useState<OwnedDeletePreview | null>(null);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const asked = useRef(false);
  const previewIt = useAppMutation({
    fn: () => previewOwnedDelete(orgId, itemId),
    invalidates: () => [],
  });
  const remove = useAppMutation({
    fn: (previewHash: string) => deleteOwned(orgId, itemId, previewHash),
    // The detail being left is not read again (a 404 would flash the not-found state first)
    invalidates: () => pluginChangeKeysButDetail(orgId),
    forgetsOnLeave: () => [keys.org(orgId).catalogItem(itemId)],
  });
  const { mutateAsync: ask } = previewIt;
  const load = useCallback(
    () =>
      ask(undefined).then(
        (p) => setPreview(p),
        (e: unknown) => setError(errorMessage(e)),
      ),
    [ask, errorMessage],
  );
  useEffect(() => {
    if (asked.current) return;
    asked.current = true;
    void load();
  }, [load]);

  const confirm = async () => {
    if (preview === null) return;
    setError(undefined);
    setNotice(undefined);
    try {
      await remove.mutateAsync(preview.previewHash);
      toast.success(
        preview.outcome === "transferred" ? t("doneTransferred", { name }) : t("done", { name }),
      );
      onDeleted();
    } catch (e) {
      if (e instanceof ApiClientError && e.code === "catalog.preview_stale") {
        setPreview(null);
        await load();
        setNotice(t("stale"));
      } else setError(errorMessage(e));
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={t("title", { name })}
      danger
      initialFocus="cancel"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("cancel")}
          </Button>
          <Button
            variant="danger-solid"
            loading={remove.isPending}
            disabled={preview === null || remove.isPending}
            onClick={() => void confirm()}
          >
            {t("confirm")}
          </Button>
        </>
      }
    >
      <Stack gap={12}>
        {notice !== undefined && (
          <Text variant="prose" tone="warn">
            {notice}
          </Text>
        )}
        {preview === null ? (
          error === undefined && (
            <Text variant="prose" tone="muted">
              {t("loading")}
            </Text>
          )
        ) : (
          <>
            <Text variant="prose" {...(preview.outcome === "transferred" && { tone: "warn" })}>
              {preview.outcome === "transferred"
                ? t("transferred", { orgs: preview.orgs.map((o) => o.name).join(sep) })
                : t("removed")}
            </Text>
            {preview.agents.length > 0 && (
              <Stack gap={4}>
                <Text variant="small" tone="warn">
                  {t("agents")}
                </Text>
                {preview.agents.map((a) => (
                  <Text key={a.id} variant="small">
                    {`· ${a.name}`}
                  </Text>
                ))}
              </Stack>
            )}
          </>
        )}
        {error !== undefined && <FormError message={error} />}
      </Stack>
    </Dialog>
  );
}
