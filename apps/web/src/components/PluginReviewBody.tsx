"use client";

import {
  Badge,
  Callout,
  CodeBlock,
  Disclosure,
  Icon,
  ItemList,
  ItemListItem,
  KeyValue,
  Stack,
  Subsection,
  Text,
  versionLabel,
} from "@capybara-hq/design";
import { useLocale, useTranslations } from "next-intl";
import type { ReactNode } from "react";
import {
  descriptionOf,
  endpointLeaves,
  hasHiddenCharacters,
  type PermissionsMismatch,
  type PluginReview,
  type PluginReviewExtension,
  shortCommit,
  showValue,
  templateNeed,
} from "../lib/catalog";
import type { PermissionGroup } from "../lib/extensions";
import {
  ComponentSection,
  HiddenCharactersWarning,
  LicenseView,
  TranslationReportView,
  useOrigin,
} from "./CatalogParts";
import { PermissionReview } from "./PermissionReview";

/** The first sentence of a description (up to the first `。` or `. `) and the rest after it. */
export function splitDescription(text: string): { first: string; rest: string } {
  const cuts = [text.indexOf("。"), text.indexOf(". ")].filter((n) => n >= 0);
  if (cuts.length === 0) return { first: text, rest: "" };
  const at = Math.min(...cuts) + 1;
  return { first: text.slice(0, at).trim(), rest: text.slice(at).trim() };
}

/** The top-level name of a config field path (`deployment:sandbox.apiKey` -> `sandbox`). */
const topLevelField = (item: string): string =>
  (item.startsWith("deployment:") ? item.slice("deployment:".length) : item).split(".")[0] ?? item;

const isDeploymentSecret = (item: string) => item.startsWith("deployment:");

/**
 * The sensitive items of a review as one number: the sensitive entries of the extension's
 * permissions plus its migration warnings (never fewer than one when the kernel marks the review
 * sensitive for another reason).
 */
function sensitiveTotal(review: PluginReview): number {
  const ext = review.extension;
  const n =
    ext === undefined
      ? 0
      : ext.permissions.flatMap((g) => g.entries).filter((e) => e.sensitive).length +
        ext.warnings.length;
  return n === 0 && review.sensitive ? 1 : n;
}

/**
 * A plugin package's review, shared by the super admin's import (`/admin/plugins/import`) and an
 * org admin's upload (`OrgPluginUploadDialog`), as the approved mockup draws it (spec §5.4): the
 * head (name, a version chip, one sensitive total, the first sentence of the description), the
 * publisher, source and build, a marketplace permission mismatch, a Claude Code translation
 * summary, then the sections that hold something (the extension with what it provides and its
 * config fields, the skills, the connector templates, the agent templates, the dependencies); the
 * empty ones are one closing line.
 */
export function PluginReviewBody({
  review,
  mismatch = null,
  audience = "platform",
}: {
  review: PluginReview;
  /** A marketplace import's permission summary that differs from the package. */
  mismatch?: PermissionsMismatch;
  /**
   * `org`: an org admin's view, contents and effect only: no source, build, license or
   * deployment-level import notices (the org cannot act on them).
   */
  audience?: "platform" | "org";
}) {
  const t = useTranslations("catalog.admin.review");
  const tt = useTranslations("catalog.admin.review.translation");
  const tc = useTranslations("catalog.components");
  const tier = useTranslations("agents.form.subagents.tier");
  const ttier = (t: "inherit" | "fast" | "standard" | "capable") => tier(t);
  const origin = useOrigin();
  const locale = useLocale();
  const platform = audience === "platform";
  const description = splitDescription(descriptionOf(review, locale));
  const detail = review.source.detail;
  const provenance = review.provenance;
  // Provenance exists only for npm packages: an npm import or a marketplace entry from the registry
  const fromNpm = review.source.kind === "npm" || (detail !== undefined && "registry" in detail);
  const fromGit = review.source.kind === "git" || (detail !== undefined && "repo" in detail);
  const ext = review.extension;
  const versionChip =
    ext?.action === "upgrade" && ext.currentVersion != null
      ? t("versionChange", {
          from: versionLabel(ext.currentVersion),
          to: versionLabel(ext.version),
        })
      : ext?.action === "keep"
        ? t("action.keep", { version: versionLabel(review.version) })
        : t("action.install", { version: versionLabel(review.version) });
  const sensitive = sensitiveTotal(review);
  const facts: { k: string; v: ReactNode }[] = [
    ...(review.publisher !== "" ? [{ k: t("facts.publisher"), v: review.publisher }] : []),
    ...(platform && (review.packageName !== null || detail !== undefined)
      ? [
          {
            k: t("facts.origin"),
            v: (
              <Stack direction="row" gap={8} align="center">
                {(fromNpm || fromGit) && <Badge>{fromNpm ? "npm" : "git"}</Badge>}
                <Text truncate>
                  {detail !== undefined && (fromGit || review.packageName === null)
                    ? origin(detail)
                    : review.packageName}
                </Text>
              </Stack>
            ),
          },
        ]
      : []),
    // display only: never fetched or compared with the source
    ...(platform && review.repository !== undefined
      ? [
          {
            k: t("facts.repository"),
            v: t("facts.repositoryValue", { repository: review.repository }),
          },
        ]
      : []),
    // display only: the attestation's signatures are not verified
    ...(platform && provenance.checked
      ? [
          {
            k: t("build"),
            v: `${provenance.repository}@${shortCommit(provenance.commit)} ${t("unverified")}`,
          },
        ]
      : platform && fromNpm && !provenance.checked
        ? [
            {
              k: t("build"),
              v: t("facts.provenanceNotChecked", { reason: provenance.reason }),
            },
          ]
        : []),
  ];
  const templates = review.connectorTemplates;
  const agents = review.agentTemplates ?? [];
  // The sections that hold nothing are not drawn: one closing line names them
  const emptyKinds = [
    ...(ext === undefined ? [tc("extension")] : []),
    ...(review.skills.length === 0 ? [tc("skills")] : []),
    ...(templates.length === 0 ? [tc("templates")] : []),
    ...(agents.length === 0 ? [tc("agentTemplates")] : []),
    ...(review.dependencies.length === 0 ? [tc("dependencies")] : []),
  ].map((k) => k.toLocaleLowerCase(locale));
  return (
    <Stack gap={16}>
      <Stack gap={8}>
        <Stack direction="row" gap={8} align="center">
          <Text variant="h3">
            {review.displayName === undefined
              ? review.name
              : locale === "zh"
                ? review.displayName.zh
                : review.displayName.en}
          </Text>
          <Badge>{versionChip}</Badge>
          {review.format === "claude-code" && <Badge>{tt("formatClaude")}</Badge>}
          {sensitive > 0 && <Badge tone="warn">{t("sensitiveCount", { n: sensitive })}</Badge>}
        </Stack>
        {description.first !== "" && <Text variant="prose">{description.first}</Text>}
        {description.rest !== "" && (
          <Disclosure summary={t("fullDescription")}>
            <Text variant="prose" pre>
              {description.rest}
            </Text>
          </Disclosure>
        )}
      </Stack>
      {platform &&
        (review.pluginVersion !== undefined ||
          review.provenanceWarning === "repository_mismatch") && (
          <Callout tone="warn">
            <Stack gap={4}>
              {review.pluginVersion !== undefined && (
                <span>
                  {t("buildVersion", {
                    version: versionLabel(review.version),
                    pluginVersion: versionLabel(review.pluginVersion),
                  })}
                </span>
              )}
              {review.provenanceWarning === "repository_mismatch" && (
                <span>{t("provenanceMismatch")}</span>
              )}
            </Stack>
          </Callout>
        )}
      {facts.length > 0 && <KeyValue rows={facts} keyWidth="10ch" />}
      {platform && review.claudeManifestIgnored === true && (
        <Text variant="small" tone="muted">
          {tt("claudeManifestIgnored")}
        </Text>
      )}
      {platform && (
        <LicenseView text={review.licenseText} truncated={review.licenseTruncated === true} />
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
      {review.translation !== undefined && <TranslationReportView report={review.translation} />}
      {ext !== undefined && (
        <ComponentSection title={tc("extension")} count={1} empty={tc("extensionNone")}>
          <ExtensionReview extension={ext} />
        </ComponentSection>
      )}
      {review.skills.length > 0 && (
        <ComponentSection
          title={tc("skills")}
          count={review.skills.length}
          empty={tc("skillsNone")}
        >
          <ItemList label={tc("skills")}>
            {review.skills.map((s) => (
              <ItemListItem
                key={s.path}
                title={s.name}
                marks={
                  <>
                    <Badge>{tc("skillFiles", { n: s.files })}</Badge>
                    {hasHidden([s.description, s.body]) && (
                      <Badge tone="warn">{t("hiddenCharacters")}</Badge>
                    )}
                  </>
                }
                meta={
                  <Text variant="small" tone="muted">
                    {s.description}
                  </Text>
                }
              >
                <Disclosure summary={tt("skillBody", { name: s.name })}>
                  <Stack gap={8}>
                    <HiddenCharactersWarning texts={[s.description, s.body]} />
                    <CodeBlock text={s.body} />
                  </Stack>
                </Disclosure>
              </ItemListItem>
            ))}
          </ItemList>
        </ComponentSection>
      )}
      {templates.length > 0 && (
        <ComponentSection
          title={tc("templates")}
          count={templates.length}
          empty={tc("templatesNone")}
        >
          {/* One row per template: name, what it needs, the address; the details are folded */}
          <ItemList label={tc("templates")}>
            {templates.map((c) => {
              const need = templateNeed(c);
              const name = c.displayName[locale === "zh" ? "zh" : "en"] ?? c.id;
              const desc = descriptionOf(c, locale);
              const host = hostOf(c.endpoint);
              const meta = [host, c.editableEndpoint.length > 0 ? t("orgCanChange") : ""].filter(
                (x) => x !== "",
              );
              return (
                <ItemListItem
                  key={c.id}
                  title={name}
                  marks={
                    <>
                      {need !== undefined && (
                        <Badge>
                          {need === "client" ? t("needsOAuthClient") : t("needsOrgCredential")}
                        </Badge>
                      )}
                      {!c.endpointChecked && <Badge tone="warn">{t("endpointUnchecked")}</Badge>}
                    </>
                  }
                  meta={
                    <>
                      {desc !== "" && (
                        <Text variant="small" tone="muted" truncate>
                          {desc}
                        </Text>
                      )}
                      {meta.length > 0 && (
                        <Text variant="small" tone="muted">
                          {meta.join(" · ")}
                        </Text>
                      )}
                    </>
                  }
                >
                  <Disclosure summary={t("endpointDetails")}>
                    <Stack gap={4}>
                      <KeyValue
                        keyWidth="14ch"
                        rows={endpointLeaves(c.endpoint).map(([k, v]) => ({ k, v: showValue(v) }))}
                      />
                      {c.editableEndpoint.length > 0 && (
                        <Text variant="small" tone="muted">
                          {t("editable", { paths: c.editableEndpoint.join(", ") })}
                        </Text>
                      )}
                      <Text variant="small">
                        {t("auth", { type: String(c.auth.type ?? "none") })}
                      </Text>
                    </Stack>
                  </Disclosure>
                </ItemListItem>
              );
            })}
          </ItemList>
        </ComponentSection>
      )}
      {agents.length > 0 && (
        <ComponentSection
          title={tc("agentTemplates")}
          count={agents.length}
          empty={tc("agentTemplatesNone")}
        >
          <ItemList label={tc("agentTemplates")}>
            {agents.map((a) => (
              <ItemListItem
                key={a.path}
                title={a.name}
                marks={
                  <>
                    <Badge>{ttier(a.model)}</Badge>
                    {hasHidden([a.description, a.instructions]) && (
                      <Badge tone="warn">{t("hiddenCharacters")}</Badge>
                    )}
                  </>
                }
                meta={
                  <Text variant="small" tone="muted">
                    {a.description}
                  </Text>
                }
              >
                <Stack gap={8}>
                  <KeyValue
                    keyWidth="6ch"
                    rows={[
                      {
                        k: t("tools"),
                        v:
                          a.tools === undefined && (a.disallowedTools ?? []).length === 0 ? (
                            tc("agentToolsInherit")
                          ) : (
                            <Chips
                              items={[
                                ...(a.tools ?? []),
                                ...(a.disallowedTools ?? []).map((x) =>
                                  tc("agentToolsRemoved", { tools: x }),
                                ),
                              ]}
                            />
                          ),
                      },
                    ]}
                  />
                  <Disclosure summary={tc("agentInstructions", { name: a.name })}>
                    <Stack gap={8}>
                      <HiddenCharactersWarning texts={[a.description, a.instructions]} />
                      <CodeBlock text={a.instructions} />
                    </Stack>
                  </Disclosure>
                </Stack>
              </ItemListItem>
            ))}
          </ItemList>
        </ComponentSection>
      )}
      {review.dependencies.length > 0 && (
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

const hasHidden = (texts: string[]): boolean => texts.some((x) => hasHiddenCharacters(x));

/** The host of an endpoint's `url`, if it has one. */
function hostOf(endpoint: Record<string, unknown>): string {
  const url = endpoint.url;
  if (typeof url !== "string") return "";
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

/** Short values as a row of chips. */
function Chips({ items, added = new Set() }: { items: string[]; added?: Set<string> }) {
  const t = useTranslations("catalog.admin.review");
  return (
    <Stack direction="row" gap={4} wrap>
      {items.map((x, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: names may repeat; the order is fixed
        <Stack key={`${i}:${x}`} direction="row" gap={4} align="center">
          <Badge>{x}</Badge>
          {added.has(x) && <Badge tone="accent">{t("newMark")}</Badge>}
        </Stack>
      ))}
    </Stack>
  );
}

/**
 * An extension: what it provides (extension point chips and, in plain words, why that is
 * sensitive) and its top-level config fields as chips (a lock on the secret ones; they are filled
 * in after the install), then the rest of its permissions.
 */
function ExtensionReview({ extension }: { extension: PluginReviewExtension }) {
  const t = useTranslations("catalog.admin.review");
  const tp = useTranslations("extensions");
  const provides = extension.permissions.find((g) => g.category === "provides");
  const config = [
    ...new Set(
      (extension.permissions.find((g) => g.category === "config")?.items ?? []).map(topLevelField),
    ),
  ];
  const secrets = new Set(
    (extension.permissions.find((g) => g.category === "secrets")?.items ?? [])
      .filter(isDeploymentSecret)
      .map(topLevelField),
  );
  // The config fields and the provides row are drawn above; the secret fields are chips with a lock
  const rest: PermissionGroup[] = extension.permissions
    .filter((g) => g.category !== "provides" && g.category !== "config")
    .map((g) =>
      g.category === "secrets"
        ? {
            ...g,
            items: g.items.filter((i) => !isDeploymentSecret(i)),
            entries: g.entries.filter((e) => !isDeploymentSecret(e.value)),
          }
        : g,
    )
    .filter((g) => g.entries.length > 0);
  // On an update, what the new version added to the provides and config rows is marked
  const addedKeys = extension.action === "upgrade" ? extension.addedItems.map((a) => a.value) : [];
  const addedProvides = new Set(
    addedKeys.filter((k) => k.startsWith("provides:")).map((k) => k.slice("provides:".length)),
  );
  const addedConfig = new Set(
    addedKeys
      .filter((k) => /^config\.(deployment|org)(\.secret)?:/.test(k))
      .map((k) => topLevelField(k.slice(k.indexOf(":") + 1))),
  );
  const reasons = [
    ...new Set(
      (provides?.entries ?? []).flatMap((e) => {
        const key = `review.reason.${e.reason}`;
        return e.sensitive && e.reason !== undefined && tp.has(key) ? [tp(key)] : [];
      }),
    ),
  ];
  const showPermissions =
    rest.length > 0 ||
    extension.warnings.length > 0 ||
    extension.permissions.length === 0 ||
    (extension.action === "upgrade" &&
      (extension.addedItems.length > 0 || extension.removed.length > 0));
  const rows = [
    ...(provides !== undefined && provides.entries.length > 0
      ? [
          {
            k: t("provides"),
            v: (
              <Stack gap={4}>
                <Stack direction="row" gap={4} wrap align="center">
                  <Chips items={provides.entries.map((e) => e.value)} added={addedProvides} />
                  {provides.entries.some((e) => e.sensitive) && (
                    <Badge tone="warn">{tp("sensitive")}</Badge>
                  )}
                </Stack>
                {reasons.map((r) => (
                  <Text key={r} variant="small" tone="warn">
                    {r}
                  </Text>
                ))}
              </Stack>
            ),
          },
        ]
      : []),
    ...(config.length > 0
      ? [
          {
            k: t("config"),
            v: (
              <Stack gap={4}>
                <Stack direction="row" gap={4} wrap>
                  {config.map((f) => (
                    <Stack key={f} direction="row" gap={4} align="center">
                      {/* A secret field is counted among the sensitive items: drawn in warn */}
                      <Badge {...(secrets.has(f) && { tone: "warn" as const })}>
                        {secrets.has(f) && <Icon name="lock" size={12} label={t("secret")} />}
                        {f}
                      </Badge>
                      {addedConfig.has(f) && <Badge tone="accent">{t("newMark")}</Badge>}
                    </Stack>
                  ))}
                </Stack>
                <Text variant="small" tone="muted">
                  {t("configAfterInstall")}
                </Text>
              </Stack>
            ),
          },
        ]
      : []),
  ];
  // A subsection, not a card (spec §6.32): the review sits on the import page and in the org's
  // upload Dialog, and its permission rows already group with hairlines.
  return (
    <Subsection title={extension.name}>
      <Stack gap={8}>
        {extension.action === "keep" && (
          <Text>
            {t("action.keep", {
              version: versionLabel(extension.currentVersion ?? extension.version),
            })}
          </Text>
        )}
        {rows.length > 0 && <KeyValue rows={rows} keyWidth="8ch" />}
        {showPermissions && (
          <PermissionReview
            plugin={extension.name}
            groups={rest}
            {...(extension.action === "upgrade" && {
              added: extension.addedItems,
              removed: extension.removed,
            })}
            warnings={extension.warnings}
            {...(extension.client !== undefined && {
              clientFiles: extension.client.files.map((f) => ({ path: f.path, bytes: f.size })),
            })}
          />
        )}
      </Stack>
    </Subsection>
  );
}
