"use client";

import { Badge, ImageBlock, Text } from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import type { CatalogSource, DirectoryItem, DirectoryPolicy, PackageKind } from "../lib/directory";

/** 种类的文案。 */
export function useKindLabel(): (kind: PackageKind) => string {
  const t = useTranslations("directory.kind");
  return (kind) => t(kind);
}

/** 策略徽标：禁用用强调色，其余普通。 */
export function PolicyBadge({ policy }: { policy: DirectoryPolicy }) {
  const t = useTranslations("directory.policy");
  return policy === "allow" ? (
    <Text variant="small">{t(policy)}</Text>
  ) : (
    <Badge tone={policy === "disabled" ? "accent" : "default"}>{t(policy)}</Badge>
  );
}

/** 条目来源的文案：手动导入、官方清单、企业清单名（来源清单已删除时显示「已删除的清单」）。 */
export function useSourceLabel(
  sources: CatalogSource[],
): (item: Pick<DirectoryItem, "catalogSourceId">) => string {
  const t = useTranslations("directory.source");
  return (item) => {
    if (item.catalogSourceId === null) return t("manual");
    if (item.catalogSourceId === "official") return t("official");
    return sources.find((s) => s.id === item.catalogSourceId)?.name ?? t("removed");
  };
}

/**
 * 条目图标：只用 `<img>`（design 的 ImageBlock）显示内核路由给出的图标；SVG 绝不内联。
 * ImageBlock 只认 http(s) 绝对地址，这里把同源相对地址拼成绝对地址（浏览器里才有 origin）。
 */
export function DirectoryIcon({ src, name }: { src: string; name: string }) {
  const t = useTranslations("directory");
  const [abs, setAbs] = useState<string | null>(null);
  useEffect(() => {
    setAbs(new URL(src, window.location.origin).href);
  }, [src]);
  return abs === null ? null : <ImageBlock src={abs} alt={t("iconAlt", { name })} />;
}
