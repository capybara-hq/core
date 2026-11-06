"use client";

import {
  Button,
  Dialog,
  Field,
  Input,
  Stack,
  SwitchField,
  Textarea,
  useToast,
} from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { useRouter } from "../i18n/navigation";
import { issueLines } from "../lib/api";
import { keys } from "../lib/query/keys";
import { useAppMutation } from "../lib/query/mutation";
import { createSkillFromText, isSkillName, SKILL_DESCRIPTION_MAX_CHARS } from "../lib/skills";
import { useErrorMessage } from "../lib/use-error-message";
import { FormError } from "./form-error";

/**
 * 新建技能 on the 技能 page (org admins; plugin scope phase 3, Task 10's text form): 名称, 描述,
 * 内容 (the SKILL.md body; a leading `---` frontmatter is dropped except the invocation keys, which
 * the help says) and 可共享 (off by default). The primary is disabled until the form is valid; a
 * created skill invalidates the library and opens its detail. 409 `skill.name_exists` keeps the
 * dialog open with its copy.
 */
export function SkillCreateDialog({ orgId, onClose }: { orgId: string; onClose(): void }) {
  const t = useTranslations("skills.create");
  const toast = useToast();
  const router = useRouter();
  const errorMessage = useErrorMessage();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [body, setBody] = useState("");
  const [shareable, setShareable] = useState(false);
  const [error, setError] = useState<{ message: string; extra: string[] }>();
  const create = useAppMutation({
    fn: () =>
      createSkillFromText(orgId, { name, description: description.trim(), body, shareable }),
    invalidates: (_, r) => [
      keys.org(orgId).skills(),
      keys.org(orgId).skill(r.skill.id),
      keys.org(orgId).componentsAll(),
    ],
  });
  const nameBad = name !== "" && !isSkillName(name);
  const valid = isSkillName(name) && description.trim() !== "" && body.trim() !== "";

  const submit = async () => {
    if (!valid || create.isPending) return;
    setError(undefined);
    try {
      const r = await create.mutateAsync(undefined);
      toast.success(t("created", { name: r.skill.name }));
      onClose();
      router.push(`/skills/${encodeURIComponent(r.skill.id)}`);
    } catch (e) {
      setError({ message: errorMessage(e), extra: issueLines(e) });
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !create.isPending) onClose();
      }}
      title={t("title")}
      size={640}
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
        <Field
          label={t("name")}
          required
          help={t("nameHelp")}
          {...(nameBad && { error: t("nameInvalid") })}
        >
          <Input value={name} maxLength={64} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label={t("description")} required help={t("descriptionHelp")}>
          <Textarea
            rows={2}
            maxLength={SKILL_DESCRIPTION_MAX_CHARS}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </Field>
        <Field label={t("body")} required help={t("bodyHelp")}>
          <Textarea code rows={10} value={body} onChange={(e) => setBody(e.target.value)} />
        </Field>
        <SwitchField
          label={t("shareable")}
          checked={shareable}
          onChange={setShareable}
          disabled={create.isPending}
        />
        {error !== undefined && <FormError message={error.message} extra={error.extra} />}
      </Stack>
    </Dialog>
  );
}
