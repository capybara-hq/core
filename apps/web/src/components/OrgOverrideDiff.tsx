"use client";

import { Button, ItemList, ItemListItem, Subsection, Text } from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import type { OrgOverrideView } from "../lib/extensions";

const show = (v: unknown): string =>
  v === undefined ? "—" : typeof v === "string" ? v : JSON.stringify(v);

/**
 * An org copy next to the platform (spec A §5.5): each overridable non-secret field that differs,
 * with both values and 采用平台值 (take the platform's current value into the copy); each secret
 * with only whether each side is configured, never compared, never a value. Built from
 * `Subsection` and `ItemList` rows, so it sits in the Sheet's box.
 */
export function OrgOverrideDiff({
  view,
  busy,
  onTake,
}: {
  view: OrgOverrideView;
  busy: boolean;
  onTake(path: string): void;
}) {
  const t = useTranslations("extensions.overrides");
  const differing = view.fields.filter((f) => f.level === "override" && !f.secret && f.differs);
  const secrets = view.fields.filter((f) => f.level === "override" && f.secret);
  return (
    <Subsection title={t("compare")} description={t("compareHint")}>
      {differing.length === 0 && secrets.length === 0 ? (
        <Text variant="prose" tone="muted">
          {t("same")}
        </Text>
      ) : (
        <ItemList label={t("compare")}>
          {differing.map((f) => (
            <ItemListItem
              key={f.path}
              title={f.path}
              actions={
                <Button density="dense" disabled={busy} onClick={() => onTake(f.path)}>
                  {t("take")}
                </Button>
              }
              meta={[
                <Text key="org" variant="small">
                  {t("orgValue", { value: show(f.org?.value) })}
                </Text>,
                <Text key="platform" variant="small" tone="muted">
                  {t("platformValue", { value: show(f.platform.value) })}
                </Text>,
              ]}
            />
          ))}
          {secrets.map((f) => (
            <ItemListItem
              key={f.path}
              title={f.path}
              meta={[
                <Text key="platform" variant="small" tone="muted">
                  {f.platform.set === true ? t("platformConfigured") : t("unconfigured")}
                </Text>,
                <Text key="org" variant="small">
                  {f.org?.set === true ? t("orgConfigured") : t("unconfigured")}
                </Text>,
              ]}
            />
          ))}
        </ItemList>
      )}
    </Subsection>
  );
}
