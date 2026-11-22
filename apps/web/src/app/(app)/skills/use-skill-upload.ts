"use client";

import { useToast } from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { useRef, useState } from "react";
import { useCatalogErrorLines } from "../../../components/CatalogParts";
import { ApiClientError, issueLines } from "../../../lib/api";
import { keys } from "../../../lib/query/keys";
import { useAppMutation } from "../../../lib/query/mutation";
import { precheckSkillZip, uploadSkillZip } from "../../../lib/skills";
import { useErrorMessage } from "../../../lib/use-error-message";

/**
 * The skill upload's state, owned by the page that opens the upload dialog: a dialog draws once
 * per size class, so its body remounts when the window crosses 600 and keeps no state of its own
 * (an in-flight upload, its progress, its error, the file to retry and the abort handle survive).
 */
export function useSkillUpload(orgId: string, onUploaded: () => void) {
  const t = useTranslations("skills.upload");
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const catalogLines = useCatalogErrorLines();
  const [busy, setBusy] = useState<{ name: string; progress: number }>();
  const [error, setError] = useState<{ message: string; extra: string[] }>();
  const [cancelled, setCancelled] = useState(false);
  /** The file that can be retried (the last upload failed or was cancelled). */
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

  return {
    busy,
    error,
    cancelled,
    failed,
    upload,
    cancel: () => ctrl.current?.abort(),
    /** Forget a finished attempt's outcome (the dialog opens clean); an upload in flight stays. */
    reset: () => {
      if (busy !== undefined) return;
      setError(undefined);
      setCancelled(false);
      setFailed(undefined);
    },
  };
}

export type SkillUpload = ReturnType<typeof useSkillUpload>;
