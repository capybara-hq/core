"use client";

import { Badge, ImageBlock, Stack, Text } from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { type ReactNode, useEffect, useState } from "react";
import {
  type CatalogItem,
  type CatalogPolicy,
  dependencyOfError,
  gitLocation,
  type Marketplace,
  namedByMessage,
  type SourceDetail,
  shortCommit,
  skillConflictsOfError,
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

/**
 * The detail lines of a catalog error that the translated copy cannot name: the dependency of a
 * `catalog.dependency_*` error (or the cycle), one line per skill of `plugin.skill_conflict` (the
 * org's own skill or the plugin it comes from), and the kernel's message for the codes whose message
 * names the host, ref or version (`marketplace.host_not_allowed`, `private_address`, `git_*`, …).
 * None for other errors; the envelope's `{ path, message }` details come from `issueLines`.
 */
export function useCatalogErrorLines(): (e: unknown) => string[] {
  const t = useTranslations("catalog.components");
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
            name: c.source.name,
            version: c.source.version,
          }),
    );
    return [...dependency, ...skills, ...namedByMessage(e)];
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
