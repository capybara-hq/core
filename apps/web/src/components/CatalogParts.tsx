"use client";

import { Badge, CodeBlock, Disclosure, ImageBlock, Stack, Text } from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { type ReactNode, useEffect, useState } from "react";
import {
  type CatalogItem,
  type CatalogPolicy,
  dependencyOfError,
  errorDetailOf,
  gitLocation,
  hasHiddenCharacters,
  type Marketplace,
  type SourceDetail,
  shortCommit,
  skillConflictsOfError,
  TRANSLATION_DETAIL_KEYS,
  TRANSLATION_GROUPS,
  type TranslationGroup,
  type TranslationItem,
  type TranslationReport,
  translationExtras,
  translationValues,
} from "../lib/catalog";

/**
 * One kind of a plugin's components (extension, skills, connector templates, dependencies) as a
 * labelled region: the title, then the items, or `empty` when there are none (`count` 0).
 */
export function ComponentSection({
  title,
  count,
  empty,
  children,
}: {
  title: string;
  count: number;
  empty: string;
  children?: ReactNode;
}) {
  return (
    <section aria-label={title}>
      <Stack gap={8}>
        <Text>{title}</Text>
        {count === 0 ? <Text tone="muted">{empty}</Text> : children}
      </Stack>
    </section>
  );
}

/** How an item's line reads in each group: problems to act on stand out, ignored parts recede. */
const GROUP_TONE: Record<TranslationGroup, "ink" | "warn" | "muted"> = {
  imported: "ink",
  converted: "ink",
  needsInput: "warn",
  ignored: "muted",
  warnings: "warn",
};

/**
 * The translation report of a Claude Code plugin (spec §8.4), shared by the import review and the
 * catalog item: the five groups in order, each as a labelled region with its count (empty groups
 * say "None"), then "Other" for items whose group a newer kernel added (only when there are any);
 * an item reads "<component> <name>: <reason>" with its path and the detail values its localized
 * reason does not name as extra lines.
 */
export function TranslationReportView({ report }: { report: TranslationReport }) {
  const t = useTranslations("catalog.admin.review.translation");
  const known: readonly string[] = TRANSLATION_GROUPS;
  const other = report.items.filter((i) => !known.includes(i.group));
  const group = (title: string, items: TranslationItem[]) => (
    <ComponentSection key={title} title={title} count={items.length} empty={t("groupNone")}>
      {items.map((i, n) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the report's order is fixed
        <TranslationItemView key={n} item={i} />
      ))}
    </ComponentSection>
  );
  return (
    <section aria-label={t("title")}>
      <Stack gap={8}>
        <Text>{t("title")}</Text>
        <Text variant="small" tone="muted">
          {t("summary")}
        </Text>
        {report.manifestPath === null && (
          <Text variant="small" tone="muted">
            {t("noManifest")}
          </Text>
        )}
        {TRANSLATION_GROUPS.map((g) => {
          const items = report.items.filter((i) => i.group === g);
          return group(t("groupTitle", { group: t(`groups.${g}`), n: items.length }), items);
        })}
        {other.length > 0 &&
          group(t("groupTitle", { group: t("groups.other"), n: other.length }), other)}
      </Stack>
    </section>
  );
}

function TranslationItemView({ item }: { item: TranslationItem }) {
  const t = useTranslations("catalog.admin.review.translation");
  const known: readonly string[] = TRANSLATION_DETAIL_KEYS;
  // A code from a newer kernel has no copy here yet: show the code itself
  const reason = t.has(`codes.${item.code}`)
    ? t(`codes.${item.code}`, translationValues(item))
    : item.code;
  const component = t.has(`components.${item.component}`)
    ? t(`components.${item.component}`)
    : item.component;
  return (
    <Stack gap={0}>
      <Text tone={GROUP_TONE[item.group] ?? "ink"}>
        {t("item", { component, name: item.name, reason })}
      </Text>
      {item.path !== undefined && item.path !== item.name && (
        <Text variant="small" tone="muted">
          {t("path", { path: item.path })}
        </Text>
      )}
      {translationExtras(item).map(([key, value]) => (
        <Text key={key} variant="small" tone="muted">
          {known.includes(key) ? t(`detail.${key}`, { value }) : t("detailOther", { key, value })}
        </Text>
      ))}
    </Stack>
  );
}

/**
 * A warning line when any of `texts` (a SKILL.md body, a description, a license: model-visible or
 * reviewed text) holds bidi or control characters (see `hasHiddenCharacters`); nothing otherwise.
 */
export function HiddenCharactersWarning({ texts }: { texts: (string | null | undefined)[] }) {
  const t = useTranslations("catalog.admin.review.translation");
  if (!texts.some((x) => typeof x === "string" && hasHiddenCharacters(x))) return null;
  return (
    <Text variant="small" tone="warn">
      {t("bidiWarning")}
    </Text>
  );
}

/**
 * A plugin version's root LICENSE text, collapsed (spec §8.4), with the hidden characters warning;
 * when it was too long to store, a line saying so. Nothing without either.
 */
export function LicenseView({
  text,
  truncated,
}: {
  text?: string | null | undefined;
  truncated?: boolean | undefined;
}) {
  const t = useTranslations("catalog.admin.review.translation");
  if (typeof text === "string" && text !== "") {
    return (
      <Stack gap={4}>
        <HiddenCharactersWarning texts={[text]} />
        <Disclosure summary={t("license")}>
          <CodeBlock text={text} />
        </Disclosure>
      </Stack>
    );
  }
  return truncated === true ? (
    <Text variant="small" tone="muted">
      {t("licenseTruncated")}
    </Text>
  ) : null;
}

/**
 * The detail lines of a catalog error that the translated copy cannot name: the dependency of a
 * `catalog.dependency_*` error (or the cycle), one line per skill of `plugin.skill_conflict` (the
 * org's own skill or the plugin it comes from), and the envelope details of the network, git and
 * upgrade-target codes (the host, repository, ref or commit, refused entry, the version rule) as
 * localized lines. None for other errors; `{ path, message }` details come from `issueLines`.
 */
export function useCatalogErrorLines(): (e: unknown) => string[] {
  const t = useTranslations("catalog.components");
  const td = useTranslations("catalog.errorDetail");
  /** The localized line of a detailed code's envelope detail. */
  const detailLines = (e: unknown): string[] => {
    const x = errorDetailOf(e);
    if (x === null) return [];
    const d = x.detail;
    if (x.code === "plugin.upgrade_target_invalid") {
      switch (d.reason) {
        case "same_version":
          return [td("sameVersion", { version: d.version ?? "" })];
        case "deployment_version":
          if (d.deploymentVersion === undefined) return [td("notDeployed")];
          return d.allowedVersion === undefined
            ? [td("deploymentVersionNone", { deploymentVersion: d.deploymentVersion })]
            : [
                td("deploymentVersion", {
                  deploymentVersion: d.deploymentVersion,
                  allowedVersion: d.allowedVersion,
                }),
              ];
        case "dependent_range":
          return [
            td("dependentRange", {
              dependent: d.dependent ?? "",
              range: d.range ?? "",
              version: d.version ?? "",
            }),
          ];
        case "template_connector":
          return [
            td("templateConnector", {
              template: d.template ?? "",
              plugin: d.plugin ?? "",
              connector: d.connector ?? "",
            }),
          ];
        default:
          return [];
      }
    }
    if (x.code === "marketplace.path_unsupported") {
      return d.entry === undefined ? [] : [td("pathEntry", { entry: d.entry, path: d.path ?? "" })];
    }
    if (x.code.startsWith("marketplace.git_") && d.repo !== undefined && d.host !== undefined) {
      // a git failure: the repository, the ref or commit asked for, the refused entry
      return [
        [
          td("repo", { location: `${d.host}/${d.repo}` }),
          ...(d.ref !== undefined ? [td("ref", { ref: d.ref })] : []),
          ...(d.commit !== undefined ? [td("commit", { commit: shortCommit(d.commit) })] : []),
        ].join(" · "),
        ...(d.path !== undefined ? [td("entry", { path: d.path })] : []),
      ];
    }
    return [
      ...(d.host !== undefined ? [td("host", { host: d.host })] : []),
      ...(d.path !== undefined ? [td("entry", { path: d.path })] : []),
      // a git URL without .git that the server redirects (GitLab, Gitea)
      ...(d.hint === "git_suffix" ? [td("gitSuffix")] : []),
    ];
  };
  return (e) => {
    const d = dependencyOfError(e);
    const dependency =
      d === null
        ? []
        : "dependency" in d
          ? [t("errorDependency", { dependency: d.dependency })]
          : [t("errorCycle", { cycle: d.cycle })];
    const skills = skillConflictsOfError(e).map((c) =>
      c.source.kind === "org"
        ? t("skillConflictOrg", { skill: c.skill })
        : t("skillConflictPlugin", {
            skill: c.skill,
            // no trailing space when the version is unknown
            plugin:
              c.source.version === "" ? c.source.name : `${c.source.name} ${c.source.version}`,
          }),
    );
    return [...dependency, ...skills, ...detailLines(e)];
  };
}

/**
 * Where a version came from in one line: a git location with its short commit and whether it was
 * pinned or follows a branch, an archive URL, or the npm registry.
 */
export function useOrigin(): (d: SourceDetail) => string {
  const t = useTranslations("catalog.origin");
  return (d) => {
    if ("commit" in d) {
      const at = t("git", { location: gitLocation(d), commit: shortCommit(d.commit) });
      const how = !d.followsBranch
        ? t("pinned")
        : d.ref !== undefined
          ? t("followsBranch", { ref: d.ref })
          : t("followsDefault");
      return `${at} · ${how}`;
    }
    if ("url" in d) return d.url;
    return t("registry", { registry: d.registry });
  };
}

/** 策略徽标：禁用用强调色，其余普通。 */
export function PolicyBadge({ policy }: { policy: CatalogPolicy }) {
  const t = useTranslations("catalog.policy");
  return policy === "allow" ? (
    <Text variant="small">{t(policy)}</Text>
  ) : (
    <Badge tone={policy === "disabled" ? "accent" : "default"}>{t(policy)}</Badge>
  );
}

/** An item's source label: manual import, the official marketplace, or the enterprise marketplace's name ("Removed marketplace" once it is gone). */
export function useSourceLabel(
  sources: Marketplace[],
): (item: Pick<CatalogItem, "marketplaceId">) => string {
  const t = useTranslations("catalog.source");
  return (item) => {
    if (item.marketplaceId === null) return t("manual");
    if (item.marketplaceId === "official") return t("official");
    return sources.find((s) => s.id === item.marketplaceId)?.name ?? t("removed");
  };
}

/**
 * 条目图标：只用 `<img>`（design 的 ImageBlock）显示内核路由给出的图标；SVG 绝不内联。
 * ImageBlock 只认 http(s) 绝对地址，这里把同源相对地址拼成绝对地址（浏览器里才有 origin）。
 */
export function CatalogIcon({ src, name }: { src: string; name: string }) {
  const t = useTranslations("catalog");
  const [abs, setAbs] = useState<string | null>(null);
  useEffect(() => {
    setAbs(new URL(src, window.location.origin).href);
  }, [src]);
  return abs === null ? null : <ImageBlock src={abs} alt={t("iconAlt", { name })} />;
}
