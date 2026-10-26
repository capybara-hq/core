import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Catalog } from "../../../../../dev/catalog";
import {
  devUiEnabled,
  isCatalogRoute,
  referenceComponentOf,
} from "../../../../../dev/catalog/routes";

/**
 * `/[locale]/dev/ui/...`：设计系统目录页（仅开发用，假数据渲染每个组件状态与模板）。
 * 生产环境（NODE_ENV=production 且 CAPYBARA_DEV_UI 不为 "1"）返回 404。
 * 门禁读运行时环境变量：先 `await connection()` 显式退出预渲染，
 * 保证判断发生在请求时，不会被构建期的环境变量值固化进静态页面。
 */
export default async function DevUiPage({
  params,
}: {
  params: Promise<{ locale: string; slug?: string[] }>;
}) {
  await connection();
  if (!devUiEnabled()) notFound();
  const { slug } = await params;
  const route = (slug ?? []).join("/");
  if (route !== "" && !isCatalogRoute(route) && !referenceComponentOf(route)) notFound();
  return <Catalog route={route} />;
}
