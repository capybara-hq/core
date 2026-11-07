"use client";

import {
  Button,
  Dialog,
  Field,
  Input,
  ItemList,
  ItemListItem,
  LinkButton,
  Stack,
  Text,
  Textarea,
} from "@capybara-hq/design";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { useRouter } from "../i18n/navigation";
import {
  nameTakenOf,
  type SaveAsOmission,
  saveAgentAsTemplate,
  TEMPLATE_LIMITS,
  TEMPLATE_NAME_RE,
  templateNameFrom,
} from "../lib/agent-templates";
import type { Agent } from "../lib/agents";
import { ApiClientError } from "../lib/api";
import { agentsQuery } from "../lib/query/agents";
import { keys } from "../lib/query/keys";
import { useAppMutation } from "../lib/query/mutation";
import { useErrorMessage } from "../lib/use-error-message";
import { templateHref } from "./AgentTemplateCards";
import { FormError } from "./form-error";

/** An omission in plain words: what it is and why it stayed out (kernel `SaveAsOmission`). */
export function useOmissionText(): (o: SaveAsOmission) => string {
  const t = useTranslations("agents.saveAs");
  return (o) => {
    const kind = t.has(`kind.${o.kind}`) ? t(`kind.${o.kind}`, { name: o.name }) : o.name;
    const field =
      o.field !== undefined && t.has(`field.${o.field}`) ? t(`field.${o.field}`) : (o.field ?? "");
    // `none`: the reason's wording without a field (a blank quick action)
    const reason = t.has(`reason.${o.reason}`)
      ? t(`reason.${o.reason}`, { field: field === "" ? "none" : field })
      : t("reason.other");
    return t("line", { what: kind, why: reason });
  };
}

/**
 * 另存为模板 (ruling P4-9, org admins; from the agent page's ⋯ and the agent card's): the name
 * (default: the agent's name in the bare-name form) and the description (default: the agent's),
 * with what will be left out said before saving (the org agents in its sub-agent roster are not
 * templates, P4-10; credentials never enter a template, P4-11). A name taken in the org (409
 * `agent_template.name_taken`) names its owner, a reserved one says so, on the name field. Saved:
 * the new template's page; when the kernel left more out (`omitted`), the dialog lists it first in
 * plain words, with 打开模板.
 */
export function SaveAsTemplateDialog({
  orgId,
  agent,
  onClose,
}: {
  orgId: string;
  agent: Agent;
  onClose(): void;
}) {
  const t = useTranslations("agents.saveAs");
  const tc = useTranslations("common");
  const errorMessage = useErrorMessage();
  const omissionText = useOmissionText();
  const router = useRouter();
  const [name, setName] = useState(() => templateNameFrom(agent.definition.name));
  // the agent's name gave nothing usable (all CJK, say): the field explains the rule instead
  const derivedEmpty = templateNameFrom(agent.definition.name) === "";
  const [description, setDescription] = useState(agent.profile.description);
  const [checked, setChecked] = useState(false);
  const [saved, setSaved] = useState<{
    id: string;
    name: string;
    omitted: SaveAsOmission[];
  } | null>(null);
  // the org agents its roster names: their names from the agents list when it is cached or readable
  const agents = useQuery(agentsQuery(orgId));
  const roster = agent.definition.subagents?.agents ?? [];
  const nameOf = (id: string, as: string) =>
    agents.data?.agents.find((a) => a.id === id)?.definition.name ?? as;
  const save = useAppMutation({
    fn: (input: { name: string; description: string }) =>
      saveAgentAsTemplate(orgId, agent.id, input),
    invalidates: () => [keys.org(orgId).agentTemplates(), keys.org(orgId).componentsAll()],
  });

  const nameOk = TEMPLATE_NAME_RE.test(name);
  const descriptionOk = description.trim() !== "";
  const taken =
    save.error instanceof ApiClientError && save.error.code === "agent_template.name_taken"
      ? nameTakenOf(save.error.rawDetails)
      : undefined;
  const takenText =
    taken === undefined
      ? undefined
      : taken === null
        ? t("taken.unknown")
        : "reserved" in taken
          ? t("taken.reserved", { name: save.variables?.name ?? name })
          : taken.owner.kind === "platform"
            ? t("taken.platform")
            : taken.owner.orgId === orgId
              ? t("taken.own")
              : t("taken.org", { org: taken.owner.name });
  const nameError =
    takenText !== undefined && save.variables?.name === name
      ? takenText
      : name !== "" && !nameOk
        ? t("nameInvalid")
        : checked && name === ""
          ? t("nameRequired")
          : undefined;
  const otherError = save.error !== null && taken === undefined ? errorMessage(save.error) : null;

  async function submit() {
    setChecked(true);
    if (!nameOk || !descriptionOk || save.isPending) return;
    try {
      const r = await save.mutateAsync({ name, description: description.trim() });
      if (r.omitted.length === 0) {
        onClose();
        router.push(templateHref(r.template.id));
      } else {
        setSaved({ id: r.template.id, name: r.template.name, omitted: r.omitted });
      }
    } catch {
      // shown on the field or under the form
    }
  }

  if (saved !== null) {
    return (
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
        title={t("savedTitle", { name: saved.name })}
        initialFocus="primary"
        footer={
          <>
            <Button variant="ghost" onClick={onClose}>
              {t("close")}
            </Button>
            <LinkButton variant="primary" href={templateHref(saved.id)}>
              {t("open")}
            </LinkButton>
          </>
        }
      >
        <Stack gap={12}>
          <Text variant="prose">{t("savedOmitted")}</Text>
          <ItemList label={t("omittedLabel")}>
            {saved.omitted.map((o, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: omissions have no id; the order is theirs
              <ItemListItem key={i} title={omissionText(o)} />
            ))}
          </ItemList>
        </Stack>
      </Dialog>
    );
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={t("title", { name: agent.definition.name })}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {tc("cancel")}
          </Button>
          <Button
            variant="primary"
            loading={save.isPending}
            disabled={save.isPending}
            onClick={() => void submit()}
          >
            {t("submit")}
          </Button>
        </>
      }
    >
      <Stack gap={16}>
        <Field
          label={t("name")}
          required
          help={derivedEmpty ? t("nameHelpEmpty") : t("nameHelp")}
          count={{ value: name.length, max: 64 }}
          {...(nameError !== undefined ? { error: nameError } : {})}
        >
          <Input
            name="template-name"
            value={name}
            maxLength={64}
            placeholder={t("namePlaceholder")}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Field
          label={t("description")}
          required
          count={{ value: description.length, max: TEMPLATE_LIMITS.descriptionChars }}
          {...(checked && !descriptionOk ? { error: t("descriptionRequired") } : {})}
        >
          <Textarea
            name="template-description"
            rows={3}
            maxLength={TEMPLATE_LIMITS.descriptionChars}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </Field>
        <Stack gap={4}>
          <Text variant="prose" tone="muted">
            {t("carried")}
          </Text>
          {roster.length > 0 ? (
            <>
              <Text variant="prose" tone="warn">
                {t("rosterLeftOut")}
              </Text>
              <ItemList label={t("rosterLabel")}>
                {roster.map((x) => (
                  <ItemListItem key={x.agentId} title={nameOf(x.agentId, x.as)} code={x.as} />
                ))}
              </ItemList>
            </>
          ) : null}
        </Stack>
        {otherError !== null ? <FormError message={otherError} /> : null}
      </Stack>
    </Dialog>
  );
}
