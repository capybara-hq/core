"use client";

import { Button, Dialog, Field, Input } from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { useAppMutation } from "../lib/query/define";
import { createOrg } from "../lib/session";
import { useErrorMessage } from "../lib/use-error-message";
import { useSession } from "./shell/session";

/**
 * "Create an organization": a name, then `POST /api/v1/orgs`; the new org becomes the current one.
 * Rendered only when `/me` says the account may create one (`canCreateOrg`). Focus starts on the
 * name and the submit waits for one (spec §6.7). The submit stays
 * pending until the new org's frame (usually the setup frame) replaces the page, which closes it.
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
  // The org switch that follows ends the cache's session: nothing to invalidate.
  const create = useAppMutation({ fn: createOrg, invalidates: () => [] });
  // Opened again: start from an empty form.
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (open) {
      setName("");
      setBusy(false);
      setError(undefined);
    }
  }

  async function submit() {
    const trimmed = name.trim();
    if (trimmed === "") {
      setError(t("nameRequired"));
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const { org } = await create.mutateAsync(trimmed);
      // Stays busy: the frame closes the dialog once the new org's frame arrives.
      await switchOrg(org.id);
    } catch (e) {
      setError(errorMessage(e));
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
          <Button
            variant="primary"
            loading={busy}
            disabled={name.trim() === ""}
            onClick={() => void submit()}
          >
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
