"use client";

import {
  Badge,
  Checkbox,
  CodeBlock,
  Disclosure,
  ItemList,
  ItemListItem,
  KeyValue,
  Stack,
  Subsection,
  Text,
  versionLabel,
} from "@capybara-hq/design";
import { useLocale, useTranslations } from "next-intl";
import {
  descriptionOf,
  endpointLeaves,
  type PermissionsMismatch,
  type PluginReview,
  type PluginReviewExtension,
  shortCommit,
  showValue,
} from "../lib/catalog";
import {
  ComponentSection,
  HiddenCharactersWarning,
  LicenseView,
  TranslationReportView,
  useOrigin,
} from "./CatalogParts";
import { PermissionReview } from "./PermissionReview";

/**
 * A plugin package's review, shared by the super admin's import (`/admin/plugins/import`) and an
 * org admin's upload (`OrgPluginUploadDialog`): the plugin line and its facts (package, publisher,
 * license, origin, provenance), a marketplace permission mismatch, a Claude Code translation
 * report, then the five component sections (the extension with its action and permissions, the
 * skills with their SKILL.md and, for the import, the "suggest pinned" checkboxes, the connector
 * templates, the agent templates, the dependencies).
 */
export function PluginReviewBody({
  review,
  mismatch = null,
  pinned,
  onPinned,
}: {
  review: PluginReview;
  /** A marketplace import's permission summary that differs from the package. */
  mismatch?: PermissionsMismatch;
  /**
   * The skills ticked "suggest pinned" and their setter; without them (an org's upload, whose
   * new versions keep the plugin's own suggestions) the checkboxes are left out.
   */
  pinned?: string[];
  onPinned?(next: string[]): void;
}) {
  const t = useTranslations("catalog.admin.review");
  const tt = useTranslations("catalog.admin.review.translation");
  const tc = useTranslations("catalog.components");
  const tier = useTranslations("agents.form.subagents.tier");
  const ttier = (t: "inherit" | "fast" | "standard" | "capable") => tier(t);
  const tp = useTranslations("extensions");
  const origin = useOrigin();
  const locale = useLocale();
  const description = descriptionOf(review, locale);
  const detail = review.source.detail;
  const provenance = review.provenance;
  // Provenance exists only for npm packages: an npm import or a marketplace entry from the registry
  const fromNpm = review.source.kind === "npm" || (detail !== undefined && "registry" in detail);
  return (
    <Stack gap={16}>
      <Stack gap={4}>
        <Stack direction="row" gap={8} align="center">
          <Text>{t("plugin", { name: review.name, version: versionLabel(review.version) })}</Text>
          {review.format === "claude-code" && <Badge>{tt("formatClaude")}</Badge>}
          {review.sensitive && <Badge tone="warn">{tp("sensitive")}</Badge>}
        </Stack>
        {review.pluginVersion !== undefined && (
          <Text variant="small" tone="warn">
            {t("buildVersion", {
              version: versionLabel(review.version),
              pluginVersion: versionLabel(review.pluginVersion),
            })}
          </Text>
        )}
        <Text variant="small" tone="muted">
          {[
            ...(review.packageName !== null ? [t("package", { name: review.packageName })] : []),
            ...(review.publisher !== "" ? [t("publisher", { publisher: review.publisher })] : []),
            ...(review.license !== undefined ? [t("license", { license: review.license })] : []),
          ].join(" · ")}
        </Text>
        {description !== "" && (
          <Text variant="prose" tone="muted">
            {description}
          </Text>
        )}
        {review.repository !== undefined && (
          // display only: never fetched or compared with the source
          <Text variant="small" tone="muted">
            {tt("repository", { repository: review.repository })}
          </Text>
        )}
        {detail !== undefined && (
          <Text variant="small" tone="muted">
            {t("origin", { origin: origin(detail) })}
          </Text>
        )}
        {provenance.checked ? (
          // display only: the attestation's signatures are not verified
          <Text variant="small" tone="muted">
            {t("provenance", {
              repository: provenance.repository,
              commit: shortCommit(provenance.commit),
              workflow: provenance.workflow,
            })}
          </Text>
        ) : (
          fromNpm && (
            <Text variant="small" tone="muted">
              {t("provenanceNotChecked", { reason: provenance.reason })}
            </Text>
          )
        )}
        {review.provenanceWarning === "repository_mismatch" && (
          <Text variant="small" tone="warn">
            {t("provenanceMismatch")}
          </Text>
        )}
        {review.claudeManifestIgnored === true && (
          <Text variant="small" tone="muted">
            {tt("claudeManifestIgnored")}
          </Text>
        )}
        <LicenseView text={review.licenseText} truncated={review.licenseTruncated === true} />
      </Stack>
      {/* Warn lines, not a card: the review sits in a Dialog too (spec §6.7) */}
      {mismatch !== null && (
        <Stack gap={4}>
          <Text tone="warn" icon="circle-alert">
            {t("mismatch")}
          </Text>
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
      )}
      {review.translation !== undefined && <TranslationReportView report={review.translation} />}
      <ComponentSection
        title={tc("extension")}
        count={review.extension === undefined ? 0 : 1}
        empty={tc("extensionNone")}
      >
        {review.extension !== undefined && <ExtensionReview extension={review.extension} />}
      </ComponentSection>
      <ComponentSection title={tc("skills")} count={review.skills.length} empty={tc("skillsNone")}>
        {review.skills.map((s) => (
          <Stack key={s.path} gap={4}>
            <Stack gap={0}>
              <Text>{`${s.name} · ${tc("skillFiles", { n: s.files })}`}</Text>
              <Text variant="small" tone="muted">
                {s.description}
              </Text>
            </Stack>
            <HiddenCharactersWarning texts={[s.description, s.body]} />
            <Disclosure summary={tt("skillBody", { name: s.name })}>
              <CodeBlock text={s.body} />
            </Disclosure>
          </Stack>
        ))}
        {pinned !== undefined && onPinned !== undefined && (
          <Disclosure
            summary={tt("pinnedTitle", { n: pinned.length, total: review.skills.length })}
            defaultOpen={review.translation?.sessionStart === true}
          >
            <Stack gap={8}>
              <Text variant="small" tone="muted">
                {tt("pinnedHint")}
              </Text>
              {review.translation?.sessionStart === true && (
                <Text variant="small" tone="warn">
                  {tt("sessionStartHint")}
                </Text>
              )}
              {review.skills.map((s) => (
                <Checkbox
                  key={s.path}
                  checked={pinned.includes(s.name)}
                  onChange={(on) =>
                    onPinned(on ? [...pinned, s.name] : pinned.filter((n) => n !== s.name))
                  }
                  label={tt("suggestPinned", { name: s.name })}
                />
              ))}
            </Stack>
          </Disclosure>
        )}
      </ComponentSection>
      <ComponentSection
        title={tc("templates")}
        count={review.connectorTemplates.length}
        empty={tc("templatesNone")}
      >
        {/* One row per template, split by hairlines (spec §6.33) */}
        <ItemList label={tc("templates")}>
          {review.connectorTemplates.map((c) => (
            <ItemListItem key={c.id} title={`${c.id} · ${c.plugin} / ${c.connector}`}>
              <KeyValue
                keyWidth="14ch"
                rows={endpointLeaves(c.endpoint).map(([k, v]) => ({ k, v: showValue(v) }))}
              />
              {c.editableEndpoint.length > 0 && (
                <Text variant="small" tone="muted">
                  {t("editable", { paths: c.editableEndpoint.join(", ") })}
                </Text>
              )}
              <Text variant="small">{t("auth", { type: String(c.auth.type ?? "none") })}</Text>
              {!c.endpointChecked && (
                <Text variant="small" tone="warn">
                  {t("unchecked")}
                </Text>
              )}
            </ItemListItem>
          ))}
        </ItemList>
      </ComponentSection>
      <ComponentSection
        title={tc("agentTemplates")}
        count={(review.agentTemplates ?? []).length}
        empty={tc("agentTemplatesNone")}
      >
        {(review.agentTemplates ?? []).map((a) => (
          <Stack key={a.path} gap={4}>
            <Stack gap={0}>
              <Text>{`${a.name} · ${ttier(a.model)}`}</Text>
              <Text variant="small" tone="muted">
                {a.description}
              </Text>
              <Text variant="small">
                {a.tools === undefined
                  ? tc("agentToolsInherit")
                  : tc("agentTools", { tools: a.tools.join(", ") })}
              </Text>
              {(a.disallowedTools ?? []).length > 0 && (
                <Text variant="small">
                  {tc("agentToolsRemoved", { tools: (a.disallowedTools ?? []).join(", ") })}
                </Text>
              )}
            </Stack>
            <HiddenCharactersWarning texts={[a.description, a.instructions]} />
            <Disclosure summary={tc("agentInstructions", { name: a.name })}>
              <CodeBlock text={a.instructions} />
            </Disclosure>
          </Stack>
        ))}
      </ComponentSection>
      <ComponentSection
        title={tc("dependencies")}
        count={review.dependencies.length}
        empty={tc("dependenciesNone")}
      >
        <Text variant="small" tone="muted">
          {tc("dependenciesHint")}
        </Text>
        {review.dependencies.map((d) =>
          d.resolved !== null ? (
            <Text key={d.name}>
              {tc("dependencyResolved", {
                name: d.name,
                range: d.range,
                version: versionLabel(d.resolved),
              })}
            </Text>
          ) : (
            <Text key={d.name} tone="warn">
              {tc("dependencyUnresolved", { name: d.name, range: d.range })}
            </Text>
          ),
        )}
      </ComponentSection>
    </Stack>
  );
}

function ExtensionReview({ extension }: { extension: PluginReviewExtension }) {
  const t = useTranslations("catalog.admin.review");
  const tp = useTranslations("extensions");
  const action =
    extension.action === "install"
      ? t("action.install", { version: versionLabel(extension.version) })
      : extension.action === "upgrade"
        ? t("action.upgrade", {
            from: extension.currentVersion == null ? "" : versionLabel(extension.currentVersion),
            to: versionLabel(extension.version),
          })
        : t("action.keep", {
            version: versionLabel(extension.currentVersion ?? extension.version),
          });
  // A subsection, not a card (spec §6.32): the review sits on the import page and in the org's
  // upload Dialog, and its permission rows already group with hairlines.
  return (
    <Subsection
      title={extension.name}
      {...(extension.sensitive && { actions: <Badge tone="warn">{tp("sensitive")}</Badge> })}
    >
      <Stack gap={8}>
        <Text>{action}</Text>
        <PermissionReview
          plugin={extension.name}
          groups={extension.permissions}
          {...(extension.action === "upgrade" && {
            added: extension.addedItems,
            removed: extension.removed,
          })}
          warnings={extension.warnings}
        />
      </Stack>
    </Subsection>
  );
}
