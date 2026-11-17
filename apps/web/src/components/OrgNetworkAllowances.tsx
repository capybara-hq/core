"use client";

import {
  Button,
  ErrorDetail,
  Field,
  FormSection,
  formatDateTime,
  Input,
  ItemList,
  Sheet,
  Stack,
  Text,
  useTimeZone,
  useToast,
} from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { ApiClientError } from "../lib/api";
import {
  addOrgNetworkAllowance,
  type NetworkAllowance,
  removeOrgNetworkAllowance,
} from "../lib/org-network";
import { adminOrgNetworkAllowancesQuery } from "../lib/query/admin";
import { keys } from "../lib/query/keys";
import { useAppMutation } from "../lib/query/mutation";
import { usePageQuery } from "../lib/query/page-query";
import { orgNetworkAllowancesQuery } from "../lib/query/settings";
import { useErrorMessage } from "../lib/use-error-message";

/** What a write changes: the super admin's list and the org admins' read of the same list. */
const changed = (orgId: string) => [
  keys.deployment().adminOrgNetworkAllowances(orgId),
  keys.org(orgId).networkAllowances(),
];

function useRows(
  allowances: NetworkAllowance[],
  action?: (a: NetworkAllowance) => React.ReactNode,
) {
  const timeZone = useTimeZone();
  const t = useTranslations("orgNetwork");
  return allowances.map((a) => ({
    id: a.id,
    title: a.entry,
    meta: t("added", { time: formatDateTime(a.createdAt, "compact", timeZone) }),
    ...(action !== undefined && { actions: action(a) }),
  }));
}

/** The list could not be read: one line and Retry, in the block that failed. */
function LoadFailed({ onRetry }: { onRetry(): void }) {
  const t = useTranslations("orgNetwork");
  return (
    <Stack gap={8}>
      <Text tone="fail" icon="circle-x">
        {t("loadFailed")}
      </Text>
      <Stack gap={4}>
        <Button density="dense" onClick={onRetry}>
          {t("retry")}
        </Button>
      </Stack>
    </Stack>
  );
}

/**
 * Internal endpoints for one org, in a Sheet on `/admin/orgs` (super admins; plugin safe fetch spec): the
 * entries with Remove each and a field to add one. The kernel checks and normalizes an entry; a
 * refusal is one sentence with the kernel's reason behind the "Raw error" toggle.
 */
export function OrgNetworkSheet({
  org,
  onClose,
}: {
  org: { id: string; name: string };
  onClose(): void;
}) {
  const t = useTranslations("orgNetwork");
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const read = usePageQuery(adminOrgNetworkAllowancesQuery(org.id));
  const [entry, setEntry] = useState("");
  const [error, setError] = useState<{ summary: string; detail: string } | null>(null);
  const add = useAppMutation({
    fn: addOrgNetworkAllowance,
    invalidates: (v) => changed(v.orgId),
  });
  const remove = useAppMutation({
    fn: removeOrgNetworkAllowance,
    invalidates: (v) => changed(v.orgId),
  });
  const fail = (e: unknown) =>
    setError({
      summary: errorMessage(e),
      detail: e instanceof ApiClientError ? e.message : "",
    });
  const submit = async () => {
    const value = entry.trim();
    if (value === "") return;
    setError(null);
    try {
      await add.mutateAsync({ orgId: org.id, entry: value });
      setEntry("");
      toast.success(t("added_toast"));
    } catch (e) {
      fail(e);
    }
  };
  const drop = async (a: NetworkAllowance) => {
    setError(null);
    try {
      await remove.mutateAsync({ orgId: org.id, id: a.id });
      toast.success(t("removed"));
    } catch (e) {
      fail(e);
    }
  };
  const rows = useRows(read.kind === "ready" ? read.data.allowances : [], (a) => (
    <Button
      density="dense"
      aria-label={t("removeLabel", { entry: a.entry })}
      disabled={remove.isPending}
      onClick={() => void drop(a)}
    >
      {t("remove")}
    </Button>
  ));
  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={t("sheetTitle", { name: org.name })}
    >
      <Stack gap={16}>
        <Text variant="prose" tone="muted">
          {t("help")}
        </Text>
        <Stack gap={8}>
          <Field label={t("field")} help={t("fieldHelp")}>
            <Input
              value={entry}
              placeholder="mcp.internal"
              onChange={(e) => setEntry(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void submit();
              }}
            />
          </Field>
          <Stack gap={4}>
            <Button
              variant="primary"
              density="dense"
              loading={add.isPending}
              disabled={entry.trim() === ""}
              onClick={() => void submit()}
            >
              {t("add")}
            </Button>
          </Stack>
        </Stack>
        {error !== null && (
          <div role="alert">
            <ErrorDetail
              summary={error.summary}
              {...(error.detail !== "" && { detail: error.detail })}
            />
          </div>
        )}
        {read.kind === "error" ? (
          <LoadFailed onRetry={read.retry} />
        ) : read.kind === "ready" ? (
          <ItemList label={t("listLabel")} rows={rows} empty={t("empty")} />
        ) : null}
      </Stack>
    </Sheet>
  );
}

/**
 * Internal endpoints on the org settings page: what a super admin allowed this org's extension requests to
 * reach, read-only for org admins (the copy says a super admin manages it). Members never see it:
 * the caller renders it for org admins only.
 */
export function OrgNetworkSection({ orgId }: { orgId: string }) {
  const t = useTranslations("orgNetwork");
  const read = usePageQuery(orgNetworkAllowancesQuery(orgId));
  const rows = useRows(read.kind === "ready" ? read.data.allowances : []);
  if (read.kind === "error") {
    return (
      <FormSection id="internal-endpoints" title={t("title")} description={t("sectionHelp")}>
        <LoadFailed onRetry={read.retry} />
      </FormSection>
    );
  }
  if (read.kind !== "ready") {
    return (
      <FormSection
        id="internal-endpoints"
        title={t("title")}
        description={t("sectionHelp")}
        loading={{ fields: [{ control: "input" }] }}
      />
    );
  }
  return (
    <FormSection id="internal-endpoints" title={t("title")} description={t("sectionHelp")}>
      <ItemList label={t("listLabel")} rows={rows} empty={t("empty")} />
    </FormSection>
  );
}
