"use client";

import { Button, StatusPage } from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { useRoutePath } from "../../components/shell/path";
import { useRouter } from "../../i18n/navigation";

/** (app) 内 `notFound()` 的页面：StatusPage 404（在 App Shell 内）。 */
export default function NotFound() {
  // The requested page's path (`<slug> / agents / <id>`), so the head says what was not found.
  const path = useRoutePath();
  const t = useTranslations("notFound");
  const router = useRouter();
  return (
    <StatusPage
      header={{ path, title: t("title") }}
      kind="404"
      title={t("title")}
      description={t("description")}
      action={
        <Button variant="primary" onClick={() => router.push("/")}>
          {t("back")}
        </Button>
      }
    />
  );
}
