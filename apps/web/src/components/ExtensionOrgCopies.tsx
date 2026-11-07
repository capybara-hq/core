"use client";

import {
  Button,
  DateTime,
  ItemList,
  ItemListItem,
  Skeleton,
  Stack,
  Subsection,
  Text,
} from "@capybara-hq/design";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { extensionOrgOverridesQuery } from "../lib/query/admin";
import { retryOnMountOf } from "../lib/query/client";
import { FormError } from "./form-error";

/**
 * The orgs holding their own copy of an extension's overridable config (spec A §5.7), on the
 * extension's Config tab: when each copy was made, which overridable fields differ from the
 * platform and whether each secret is configured, never a value. Read only: the org admin
 * controls a copy.
 */
export function ExtensionOrgCopies({
  name,
  variant = "guide",
}: {
  name: string;
  /** `divided`: a region of the extension's Sheet. */
  variant?: "guide" | "divided";
}) {
  const t = useTranslations("admin.extensions.orgCopies");
  const q = extensionOrgOverridesQuery(name);
  const read = useQuery({ ...q, retryOnMount: retryOnMountOf(q.queryKey) });
  let body: React.ReactNode;
  if (read.data === undefined) {
    body = read.error ? (
      <Stack gap={8}>
        <FormError message={t("loadFailed")} />
        <Stack direction="row">
          <Button density="dense" onClick={() => void read.refetch()}>
            {t("retry")}
          </Button>
        </Stack>
      </Stack>
    ) : (
      <Skeleton rows={2} />
    );
  } else if (read.data.length === 0) {
    body = (
      <Text variant="prose" tone="muted">
        {t("empty")}
      </Text>
    );
  } else {
    body = (
      <ItemList label={t("title")}>
        {read.data.map((o) => (
          <ItemListItem
            key={o.orgId}
            title={o.orgName}
            meta={[
              <Text key="since" variant="small" tone="muted">
                {t("since")} <DateTime value={o.createdAt} />
              </Text>,
              <Text key="diff" variant="small">
                {o.differing.length > 0
                  ? t("differing", { fields: o.differing.join(", ") })
                  : t("noDiff")}
              </Text>,
              ...o.secrets.map((s) => (
                <Text key={s.path} variant="small" tone="muted">
                  {t(s.set ? "set" : "unset", { path: s.path })}
                </Text>
              )),
            ]}
          />
        ))}
      </ItemList>
    );
  }
  return (
    <Subsection title={t("title")} description={t("hint")} variant={variant}>
      {body}
    </Subsection>
  );
}
