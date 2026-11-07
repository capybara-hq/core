"use client";

import {
  CodeBlock,
  FormSection,
  ItemList,
  ItemListItem,
  KeyValue,
  Stack,
  Text,
} from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import type { TemplateConnector, TemplateInlineSubagent } from "../../lib/agent-templates";
import { readInstructionFiles } from "../../lib/instruction-files";
import { QuickActionsList } from "../agent/QuickActionsEditor";
import { TemplateSectionFrame, useTemplatePage } from "./frame";
import { useConnectorTemplateName, useTemplateSource, useToolName } from "./labels";

/**
 * The template page's read view (ruling P4-14: members read every section, so they know what a
 * template brings before 用它创建): each section the agent page's way, read-only, one box each.
 */

export function BasicsRead() {
  const t = useTranslations("agents.templatePage");
  const { orgId, template } = useTemplatePage();
  const source = useTemplateSource();
  return (
    <TemplateSectionFrame>
      <FormSection id="basics" title={t("sections.basics")}>
        <KeyValue
          keyWidth="10ch"
          rows={[
            { k: t("basics.name"), v: template.name },
            { k: t("basics.type"), v: template.type },
            { k: t("basics.source"), v: source(template, orgId) },
            { k: t("basics.version"), v: `v${template.version}` },
            ...(template.owned
              ? [
                  {
                    k: t("basics.shareable"),
                    v: template.shareable ? t("basics.shareableOn") : t("basics.shareableOff"),
                  },
                ]
              : []),
          ]}
        />
      </FormSection>
    </TemplateSectionFrame>
  );
}

export function QuickActionsRead() {
  const t = useTranslations("agents.templatePage");
  const { definition } = useTemplatePage();
  return (
    <TemplateSectionFrame>
      <FormSection id="quick-actions" title={t("sections.quick-actions")} flush>
        <QuickActionsList list={definition.quickActions ?? []} />
      </FormSection>
    </TemplateSectionFrame>
  );
}

export function PromptRead() {
  const t = useTranslations("agents.templatePage");
  const tp = useTranslations("agents.page.prompt");
  const { definition } = useTemplatePage();
  const files = readInstructionFiles(definition);
  return (
    <TemplateSectionFrame>
      <FormSection id="prompt" title={t("sections.prompt")} flush>
        <ItemList label={tp("filesLabel")} inset="flush">
          {files.map((f) => (
            <ItemListItem key={f.name} title={f.name}>
              {f.content.trim() === "" ? (
                <Text tone="faint">{t("prompt.empty")}</Text>
              ) : (
                <CodeBlock language="markdown" text={f.content} />
              )}
            </ItemListItem>
          ))}
        </ItemList>
      </FormSection>
    </TemplateSectionFrame>
  );
}

export function ModelRead() {
  const t = useTranslations("agents.templatePage");
  const { definition } = useTemplatePage();
  return (
    <TemplateSectionFrame>
      <FormSection id="model" title={t("sections.model")}>
        <KeyValue
          keyWidth="10ch"
          rows={[
            { k: t("model.tier"), v: t(`tier.${definition.model ?? "standard"}`) },
            { k: t("model.modelRef"), v: definition.modelRef ?? t("model.noModelRef") },
            {
              k: t("model.effort"),
              v:
                definition.effort !== undefined
                  ? t(`effort.${definition.effort}`)
                  : t("model.noEffort"),
            },
            ...(definition.maxSteps !== undefined
              ? [{ k: t("model.maxSteps"), v: String(definition.maxSteps) }]
              : []),
          ]}
        />
      </FormSection>
    </TemplateSectionFrame>
  );
}

export function ToolsRead() {
  const t = useTranslations("agents.templatePage");
  const { definition } = useTemplatePage();
  const toolName = useToolName();
  const tools = definition.tools ?? [];
  const policies = definition.toolPolicies ?? {};
  const disallowed = definition.disallowedTools ?? [];
  return (
    <TemplateSectionFrame>
      <FormSection id="tools" title={t("sections.tools")} flush>
        <ItemList label={t("tools.list")} inset="flush" empty={t("tools.none")}>
          {tools.map((key) => {
            const p = policies[key];
            return (
              <ItemListItem
                key={key}
                title={toolName(key)}
                code={key}
                {...(p !== undefined ? { meta: t(`policy.${p}`) } : {})}
              />
            );
          })}
          {disallowed.map((key) => (
            <ItemListItem
              key={`x:${key}`}
              title={toolName(key)}
              code={key}
              meta={t("tools.disallowed")}
            />
          ))}
        </ItemList>
      </FormSection>
    </TemplateSectionFrame>
  );
}

export function SkillsRead() {
  const t = useTranslations("agents.templatePage");
  const { definition } = useTemplatePage();
  const pinned = definition.skills ?? [];
  const selected = definition.selectedSkills ?? [];
  return (
    <TemplateSectionFrame>
      <FormSection id="skills" title={t("sections.skills")} flush>
        <ItemList label={t("skills.list")} inset="flush" empty={t("skills.none")}>
          {pinned.map((name) => (
            <ItemListItem key={`p:${name}`} title={name} meta={t("skills.pinned")} />
          ))}
          {selected.map((name) => (
            <ItemListItem key={`s:${name}`} title={name} />
          ))}
        </ItemList>
      </FormSection>
    </TemplateSectionFrame>
  );
}

/** One connector entry read-only: what it is, its endpoint (a needs entry) and its tools. */
function ConnectorRow({ entry }: { entry: TemplateConnector }) {
  const t = useTranslations("agents.templatePage");
  const templateName = useConnectorTemplateName();
  const policies = Object.entries(entry.policies ?? {});
  const tools = "needs" in entry ? entry.needs.tools : entry.tools;
  return (
    <ItemListItem
      title={"needs" in entry ? entry.needs.label : templateName(entry.template)}
      meta={
        "needs" in entry
          ? t("connectors.needsKind", {
              protocol: t(`connectors.protocol.${entry.needs.protocol}`),
            })
          : t("connectors.templateKind")
      }
    >
      <KeyValue
        keyWidth="10ch"
        rows={[
          ...("needs" in entry ? [{ k: t("connectors.endpoint"), v: entry.needs.endpoint }] : []),
          {
            k: t("connectors.tools"),
            v:
              tools === undefined
                ? t("connectors.allTools")
                : tools.length === 0
                  ? t("connectors.noTools")
                  : tools.join(", "),
          },
          ...(policies.length > 0
            ? [
                {
                  k: t("connectors.policies"),
                  v: policies.map(([tool, p]) => `${tool} · ${t(`policy.${p}`)}`).join(", "),
                },
              ]
            : []),
        ]}
      />
    </ItemListItem>
  );
}

export function ConnectorsRead() {
  const t = useTranslations("agents.templatePage");
  const { definition } = useTemplatePage();
  const list = definition.connectors ?? [];
  return (
    <TemplateSectionFrame>
      <Stack gap={16}>
        {list.some((c) => "needs" in c) ? (
          <Text variant="prose" tone="muted">
            {t("connectors.needsHint")}
          </Text>
        ) : null}
        <FormSection id="connectors" title={t("sections.connectors")} flush>
          <ItemList label={t("connectors.list")} inset="flush" empty={t("connectors.none")}>
            {list.map((c, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: entries have no id; the order is theirs
              <ConnectorRow key={i} entry={c} />
            ))}
          </ItemList>
        </FormSection>
      </Stack>
    </TemplateSectionFrame>
  );
}

/** An inline sub-agent's tools in words: all, none, or the keys. */
export function useInlineTools(): (x: TemplateInlineSubagent) => string {
  const t = useTranslations("agents.templatePage.subagents");
  return (x) =>
    x.tools === undefined
      ? t("allTools")
      : x.tools.length === 0
        ? t("noTools")
        : x.tools.join(", ");
}

export function SubagentsRead() {
  const t = useTranslations("agents.templatePage");
  const tier = useTranslations("agents.form.subagents.tier");
  const { definition } = useTemplatePage();
  const inlineTools = useInlineTools();
  const s = definition.subagents ?? {};
  const types = s.types ?? [];
  const inline = s.inline ?? [];
  return (
    <TemplateSectionFrame>
      <FormSection id="subagents" title={t("sections.subagents")} flush>
        <ItemList label={t("subagents.list")} inset="flush" empty={t("subagents.none")}>
          {s.general === true ? <ItemListItem title={t("subagents.general")} /> : null}
          {types.map((type) => (
            <ItemListItem key={`t:${type}`} title={type} meta={t("subagents.typeKind")} />
          ))}
          {inline.map((x) => (
            <ItemListItem key={`i:${x.name}`} title={x.name} meta={t("subagents.inlineKind")}>
              <Stack gap={8}>
                <Text variant="prose">{x.description}</Text>
                <KeyValue
                  keyWidth="10ch"
                  rows={[
                    { k: t("subagents.model"), v: tier(x.model) },
                    { k: t("subagents.tools"), v: inlineTools(x) },
                    {
                      k: t("subagents.skills"),
                      v: x.skills.length === 0 ? t("subagents.noSkills") : x.skills.join(", "),
                    },
                  ]}
                />
                <CodeBlock language="markdown" text={x.instructions} />
              </Stack>
            </ItemListItem>
          ))}
        </ItemList>
      </FormSection>
    </TemplateSectionFrame>
  );
}
