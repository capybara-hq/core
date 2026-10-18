import { notFound } from "next/navigation";
import { Catalog } from "../../../../../dev/catalog";
import { devUiEnabled, isCatalogRoute } from "../../../../../dev/catalog/routes";

/**
 * `/[locale]/dev/ui/...`：设计系统目录页（仅开发用，假数据渲染每个组件状态与模板）。
 * 生产环境（NODE_ENV=production 且 CAPYBARA_DEV_UI 不为 "1"）返回 404。
 */
export default async function DevUiPage({
  params,
}: {
  params: Promise<{ locale: string; slug?: string[] }>;
}) {
  if (!devUiEnabled()) notFound();
  const { slug } = await params;
  const route = (slug ?? []).join("/");
  if (route !== "" && !isCatalogRoute(route)) notFound();
  return <Catalog route={route} />;
}
