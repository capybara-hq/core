"use client";

import { Button, Dialog, Field, Input, Stack, useToast } from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { useRouter } from "../i18n/navigation";
import { createEnvironment, isEnvironmentName } from "../lib/environments";
import { keys } from "../lib/query/keys";
import { useAppMutation } from "../lib/query/mutation";
import { useErrorMessage } from "../lib/use-error-message";
import { FormError } from "./form-error";

/**
 * 新建环境 on the 环境 page: one field, 名称 (1-64 characters); the primary is disabled until it is
 * valid. A created environment is ready at once (its files and instance are made on first use):
 * the dialog invalidates the list and opens the detail page. A kernel refusal (name taken, limit
 * reached, no provider) keeps the dialog open with its copy.
 */
export function EnvironmentCreateDialog({ orgId, onClose }: { orgId: string; onClose(): void }) {
  const t = useTranslations("environments.create");
  const toast = useToast();
  const router = useRouter();
  const errorMessage = useErrorMessage();
  const [name, setName] = useState("");
  const [error, setError] = useState<string>();
  const create = useAppMutation({
    fn: () => createEnvironment(orgId, name),
    invalidates: (_, r) => [
      keys.org(orgId).environments(),
      keys.org(orgId).environment(r.environment.id),
    ],
  });
  const valid = isEnvironmentName(name);

  const submit = async () => {
    if (!valid || create.isPending) return;
    setError(undefined);
    try {
      const r = await create.mutateAsync(undefined);
      toast.success(t("created", { name: r.environment.name ?? name.trim() }));
      onClose();
      router.push(`/environments/${encodeURIComponent(r.environment.id)}`);
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !create.isPending) onClose();
      }}
      title={t("title")}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={create.isPending}>
            {t("cancel")}
          </Button>
          <Button
            variant="primary"
            loading={create.isPending}
            disabled={!valid || create.isPending}
            onClick={() => void submit()}
          >
            {t("submit")}
          </Button>
        </>
      }
    >
      <Stack gap={12}>
        <Field label={t("name")} required help={t("nameHelp")}>
          <Input
            value={name}
            maxLength={64}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void submit();
            }}
          />
        </Field>
        {error !== undefined && <FormError message={error} />}
      </Stack>
    </Dialog>
  );
}
