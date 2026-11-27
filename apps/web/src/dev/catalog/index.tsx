"use client";

import { applyTheme, Button, Card, Stack, Text, useDesignLink } from "@capybara-hq/design";
import { lazy, Suspense } from "react";
import { AdminPageCatalog } from "./admin-pages";
import { AutomationsPageCatalog } from "./automations-page";
import { BrandFixtureCatalog } from "./brand-blocks";
import { ComponentsCatalog } from "./components";
import { MemberPageCatalog } from "./member-pages";
import { OverlayCatalog } from "./overlays";
import { ReferenceCatalog } from "./reference";
import {
  type AdminPage,
  CATALOG_ROUTES,
  isOverlayRoute,
  isPageRoute,
  isTemplateRoute,
  type MemberPage,
  PAGE_ROUTES,
  REFERENCE_ROUTES,
  referenceComponentOf,
  type SuperAdminPage,
} from "./routes";
import { StressCatalog } from "./stress";
import { SuperAdminPageCatalog } from "./super-admin-pages";
import { TableCatalog } from "./table";
import { TemplateCatalog } from "./templates";

/**
 * The app pages (`pages.tsx`) import real views and the app's query layer: loaded only when one is
 * opened, so the rest of the catalog stays free of them.
 */
const PageCatalog = lazy(() => import("./pages").then((m) => ({ default: m.PageCatalog })));

/** `/dev/ui/<route>` 的分发；空路由为目录首页。 */
export function Catalog({ route }: { route: string }) {
  if (route === "components") return <ComponentsCatalog />;
  if (route === "table") return <TableCatalog />;
  if (route === "stress") return <StressCatalog />;
  if (route === "brand/fixture") return <BrandFixtureCatalog />;
  if (isOverlayRoute(route)) return <OverlayCatalog route={route} />;
  if (isTemplateRoute(route)) return <TemplateCatalog route={route} />;
  // Not lazy: the calendar's phone case checks the first paint with JavaScript off, and a lazy
  // boundary streams its content hidden until a script reveals it.
  if (route === "pages/automations-calendar") return <AutomationsPageCatalog variant="week" />;
  if (route === "pages/automations-calendar-month")
    return <AutomationsPageCatalog variant="month" />;
  if (route === "pages/automations-calendar-admin")
    return <AutomationsPageCatalog variant="admin" />;
  if (route.startsWith("pages/member-") && isPageRoute(route))
    return <MemberPageCatalog page={route.slice("pages/member-".length) as MemberPage} />;
  if (route.startsWith("pages/org-") && isPageRoute(route))
    return <AdminPageCatalog page={route.slice("pages/org-".length) as AdminPage} />;
  if (route.startsWith("pages/platform-") && isPageRoute(route))
    return <SuperAdminPageCatalog page={route.slice("pages/platform-".length) as SuperAdminPage} />;
  if (isPageRoute(route)) {
    return (
      <Suspense fallback={null}>
        <PageCatalog route={route} />
      </Suspense>
    );
  }
  const component = referenceComponentOf(route);
  if (component) return <ReferenceCatalog component={component} />;
  return <CatalogHome />;
}

function CatalogHome() {
  const Link = useDesignLink();
  return (
    <Card
      title={<Text variant="h1">/dev/ui · @capybara-hq/design</Text>}
      actions={
        <Stack direction="row" gap={8}>
          <Button density="dense" onClick={() => applyTheme("dark")}>
            深色
          </Button>
          <Button density="dense" onClick={() => applyTheme("light")}>
            浅色
          </Button>
        </Stack>
      }
    >
      <Stack gap={4}>
        {[...CATALOG_ROUTES, ...PAGE_ROUTES, ...REFERENCE_ROUTES].map((r) => (
          <Link key={r} href={`/dev/ui/${r}`}>
            {r}
          </Link>
        ))}
      </Stack>
    </Card>
  );
}
