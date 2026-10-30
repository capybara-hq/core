"use client";

import { Button, Dialog, Field, Input } from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { createOrg } from "../lib/session";
import { useErrorMessage } from "../lib/use-error-message";
import { useSession } from "./shell/session";

/**
 * "Create an organization": a name, then `POST /api/v1/orgs`; the new org becomes the current one.
 * Rendered only when `/me` says the account may create one (`canCreateOrg`).
 */
export function CreateOrgDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("home.createOrg");
  const errorMessage = useErrorMessage();
  const { switchOrg } = useSession();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  async function submit() {
    const trimmed = name.trim();
    if (trimmed === "") {
      setError(t("nameRequired"));
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const { org } = await createOrg(trimmed);
      await switchOrg(org.id);
      setName("");
      onOpenChange(false);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("title")}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t("cancel")}
          </Button>
          <Button variant="primary" loading={busy} onClick={() => void submit()}>
            {t("submit")}
          </Button>
        </>
      }
    >
      <Field
        label={t("nameLabel")}
        required
        help={t("nameHint")}
        {...(error !== undefined && { error })}
      >
        <Input
          value={name}
          maxLength={100}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void submit();
          }}
        />
      </Field>
    </Dialog>
  );
}
