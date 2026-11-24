"use client";

import {
  Badge,
  Button,
  Callout,
  CodeBlock,
  Dialog,
  DisclosureLink,
  ExpandableProse,
  KeyValue,
  Stack,
  Text,
  versionLabel,
} from "@capybara-hq/design";
import { useLocale, useTranslations } from "next-intl";
import { type ReactNode, useState } from "react";
import { hasHiddenCharacters, type PermissionsMismatch, shortCommit } from "../../lib/catalog";
import {
  ComponentSection,
  HiddenCharactersWarning,
  TranslationReportView,
  useOrigin,
} from "../CatalogParts";
import {
  type Audience,
  type ContentsLicense,
  firstSentence,
  type PluginContentsModel,
  type Stage,
} from "./model";
import {
  AgentRows,
  DependencyLines,
  ExtensionBlock,
  SkillRows,
  TemplateRows,
  ThemeRows,
} from "./rows";

export type { Audience, Stage } from "./model";

/**
 * A plugin package's contents, the one view behind the platform's install and update, an org's
 * upload and enable and both plugin pages (plugin contents spec): the head (name, a version chip
 * by stage, one sensitive total, the description's first sentence with a "full description"
 * toggle), the facts (publisher; on the platform also source, build and license, whose "full
 * text" opens a Dialog), a marketplace permission mismatch, the Claude Code translation summary
 * (platform; an org's own upload too), then the sections that hold something (extension, skills,
 * connector templates, agent templates, themes, dependencies); the empty ones are one
 * closing line. Each row draws its change mark and the surface's trailing slot.
 */
export function PluginContents({
  model,
  audience,
  stage,
  mismatch = null,
}: {
  model: PluginContentsModel;
  audience: Audience;
  stage: Stage;
  /** A marketplace import's permission summary that differs from the package. */
  mismatch?: PermissionsMismatch;
}) {
  const t = useTranslations("catalog.admin.review");
  const tt = useTranslations("catalog.admin.review.translation");
  const tc = useTranslations("catalog.components");
  const origin = useOrigin();
  const locale = useLocale();
  const platform = audience === "platform";
  const { head, facts, extension: ext } = model;
  const description = model.description.trim();
  const versionChip =
    stage === "enable" || stage === "detail"
      ? versionLabel(head.version)
      : head.fromVersion != null
        ? t("versionChange", {
            from: versionLabel(head.fromVersion),
            to: versionLabel(head.version),
          })
        : head.keep === true
          ? t("action.keep", { version: versionLabel(head.version) })
          : t("action.install", { version: versionLabel(head.version) });
  const build = facts.build;
  const factRows: { k: string; v: ReactNode }[] = [
    ...(facts.publisher !== undefined ? [{ k: t("facts.publisher"), v: facts.publisher }] : []),
    ...(platform && facts.origin !== undefined
      ? [
          {
            k: t("facts.origin"),
            v: (
              <Stack direction="row" gap={8} align="center">
                {facts.origin.chip !== undefined && <Badge>{facts.origin.chip}</Badge>}
                <Text truncate>
                  {facts.origin.detail !== undefined
                    ? origin(facts.origin.detail)
                    : facts.origin.text}
                </Text>
              </Stack>
            ),
          },
        ]
      : []),
    ...(platform && facts.repository !== undefined
      ? [
          {
            k: t("facts.repository"),
            v: t("facts.repositoryValue", { repository: facts.repository }),
          },
        ]
      : []),
    ...(platform && build !== undefined
      ? [
          {
            k: t("build"),
            v:
              "notChecked" in build ? (
                t("facts.provenanceNotChecked", { reason: build.notChecked })
              ) : (
                <Stack direction="row" gap={8} align="center">
                  <Text truncate>{`${build.repository}@${shortCommit(build.commit)}`}</Text>
                  <Text variant="small" tone="muted">
                    {t("unverified")}
                  </Text>
                </Stack>
              ),
          },
        ]
      : []),
    ...(platform && facts.license !== undefined
      ? [{ k: t("facts.license"), v: <LicenseFact license={facts.license} /> }]
      : []),
  ];
  const notices = platform ? (model.notices ?? {}) : {};
  // The sections that hold nothing are not drawn: one closing line names them (themes only show
  // when a plugin has some, so they are not named)
  const emptyKinds = [
    ...(ext === undefined ? [tc("extension")] : []),
    ...(model.skills.length === 0 ? [tc("skills")] : []),
    ...(model.templates.length === 0 ? [tc("templates")] : []),
    ...(model.agents.length === 0 ? [tc("agentTemplates")] : []),
    ...(model.dependencies.length === 0 ? [tc("dependencies")] : []),
  ].map((k) => k.toLocaleLowerCase(locale));
  const dependenciesTitle = stage === "enable" ? tc("dependenciesWith") : tc("dependencies");
  return (
    <Stack gap={16}>
      <Stack gap={8}>
        {/* A page of its own (the plugin pages) has its page header: no head here */}
        {stage !== "detail" && (
          <Stack direction="row" gap={8} align="center" wrap>
            <Text variant="h3">{head.name}</Text>
            <Badge>{versionChip}</Badge>
            {head.claudeCode === true && <Badge>{tt("formatClaude")}</Badge>}
            {head.sensitive > 0 && (
              <Badge tone="warn">{t("sensitiveCount", { n: head.sensitive })}</Badge>
            )}
          </Stack>
        )}
        {description !== "" && (
          <ExpandableProse
            summary={firstSentence(description)}
            text={description}
            moreLabel={t("fullDescription")}
            lessLabel={t("collapse")}
          />
        )}
      </Stack>
      {(notices.buildVersion !== undefined || notices.provenanceMismatch === true) && (
        <Callout tone="warn">
          <Stack gap={4}>
            {notices.buildVersion !== undefined && (
              <span>
                {t("buildVersion", {
                  version: versionLabel(notices.buildVersion.version),
                  pluginVersion: versionLabel(notices.buildVersion.pluginVersion),
                })}
              </span>
            )}
            {notices.provenanceMismatch === true && <span>{t("provenanceMismatch")}</span>}
          </Stack>
        </Callout>
      )}
      {factRows.length > 0 && <KeyValue rows={factRows} keyWidth="10ch" />}
      {notices.claudeManifestIgnored === true && (
        <Text variant="small" tone="muted">
          {tt("claudeManifestIgnored")}
        </Text>
      )}
      {/* A warn Callout: the tinted bar on the import page, the warn line in the org's upload
          Dialog (it reads the box it sits in, spec §6.19) */}
      {mismatch !== null && (
        <Callout tone="warn">
          <Stack gap={4}>
            <Text tone="warn">{t("mismatch")}</Text>
            {mismatch.missing.length > 0 && (
              <Text variant="small" tone="warn">
                {t("mismatchMissing", { keys: mismatch.missing.join(", ") })}
              </Text>
            )}
            {mismatch.extra.length > 0 && (
              <Text variant="small" tone="muted">
                {t("mismatchExtra", { keys: mismatch.extra.join(", ") })}
              </Text>
            )}
          </Stack>
        </Callout>
      )}
      {(platform || stage === "install") && model.translation !== undefined && (
        <TranslationReportView report={model.translation} />
      )}
      {ext !== undefined && (
        <ComponentSection title={tc("extension")} count={1} empty={tc("extensionNone")}>
          <ExtensionBlock extension={ext} stage={stage} />
        </ComponentSection>
      )}
      {model.skills.length > 0 && (
        <ComponentSection title={tc("skills")} count={model.skills.length} empty={tc("skillsNone")}>
          <SkillRows rows={model.skills} />
        </ComponentSection>
      )}
      {model.templates.length > 0 && (
        <ComponentSection
          title={tc("templates")}
          count={model.templates.length}
          empty={tc("templatesNone")}
        >
          <TemplateRows rows={model.templates} />
        </ComponentSection>
      )}
      {model.agents.length > 0 && (
        <ComponentSection
          title={tc("agentTemplates")}
          count={model.agents.length}
          empty={tc("agentTemplatesNone")}
        >
          <AgentRows rows={model.agents} />
        </ComponentSection>
      )}
      {model.themes.length > 0 && (
        <ComponentSection title={tc("themes")} count={model.themes.length} empty="">
          <ThemeRows rows={model.themes} />
        </ComponentSection>
      )}
      {model.dependencies.length > 0 && (
        <ComponentSection
          title={dependenciesTitle}
          count={model.dependencies.length}
          empty={tc("dependenciesNone")}
        >
          <DependencyLines rows={model.dependencies} stage={stage} />
        </ComponentSection>
      )}
      {emptyKinds.length > 0 && (
        <Text variant="small" tone="muted">
          {t("noneOf", {
            kinds: new Intl.ListFormat(locale, { style: "long", type: "conjunction" }).format(
              emptyKinds,
            ),
          })}
        </Text>
      )}
    </Stack>
  );
}

/**
 * The license fact: the license's name, then a "full text" link opening a Dialog with the text
 * (a long license never stretches the page); a license too large to keep says so; a name alone
 * without a text.
 */
export function LicenseFact({ license }: { license: ContentsLicense }) {
  const t = useTranslations("catalog.admin.review");
  const tt = useTranslations("catalog.admin.review.translation");
  const [open, setOpen] = useState(false);
  const text = license.text;
  return (
    <Stack direction="row" gap={8} align="center" wrap>
      <Text>{license.name}</Text>
      {text !== undefined && hasHiddenCharacters(text) && (
        <Badge tone="warn">{t("hiddenCharacters")}</Badge>
      )}
      {text !== undefined ? (
        <>
          <DisclosureLink onSelect={() => setOpen(true)}>{t("licenseText")}</DisclosureLink>
          <Dialog
            open={open}
            onOpenChange={setOpen}
            title={tt("license")}
            size={760}
            footer={<Button onClick={() => setOpen(false)}>{t("close")}</Button>}
          >
            <Stack gap={8}>
              <HiddenCharactersWarning texts={[text]} />
              <CodeBlock text={text} />
            </Stack>
          </Dialog>
        </>
      ) : license.truncated === true ? (
        <Text variant="small" tone="muted">
          {tt("licenseTruncated")}
        </Text>
      ) : null}
    </Stack>
  );
}
