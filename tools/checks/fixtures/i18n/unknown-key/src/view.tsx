import { getTranslations, useTranslations } from "next-intl";

export function Page({ name, tp }: { name: string; tp: (k: string) => string }) {
  const t = useTranslations("page");
  const root = useTranslations();
  t("title");
  t("missing");
  t.rich("title", {});
  t.raw("group");
  t("group");
  t(`group.${name}`);
  t.has("absent");
  root("top");
  root("page.nope");
  tp("not-a-translator");
  return null;
}

export async function Server() {
  const t = await getTranslations({ locale: "zh", namespace: "page" });
  t("group.a");
  t("group.b");
}

export function Other() {
  const t = useTranslations("other");
  t("anything");
}
