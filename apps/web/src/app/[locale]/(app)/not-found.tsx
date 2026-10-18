"use client";

import { Button, StatusPage } from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { useRouter } from "../../../i18n/navigation";

/** (app) 内 `notFound()` 的页面：StatusPage 404（在 App Shell 内）。 */
export default function NotFound() {
  const t = useTranslations("notFound");
  const router = useRouter();
  return (
    <StatusPage
      header={{ title: t("title") }}
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
