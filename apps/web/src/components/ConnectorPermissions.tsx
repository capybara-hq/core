"use client";

import {
  Button,
  EmptyState,
  Sheet,
  Stack,
  Subsection,
  Text,
  ToolPolicyList,
  type ToolPolicyRow,
  useToast,
} from "@capybara-hq/design";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useState } from "react";
import {
  type ConnectorDetail,
  type MemberToolPolicy,
  setMyToolPolicies,
  type ToolPolicy,
} from "../lib/connectors";
import { retryOnMountOf } from "../lib/query/client";
import { myToolPoliciesQuery } from "../lib/query/conversation";
import { keys } from "../lib/query/keys";
import { useAppMutation } from "../lib/query/mutation";
import { useErrorMessage } from "../lib/use-error-message";
import { FormError } from "./form-error";

const POLICIES: readonly ToolPolicy[] = ["allow", "ask", "deny"];

/**
 * The connector card's 权限 (maintainer decisions 2026-11-09): the viewer's own policy per tool
 * for their own connection, 允许 / 询问 / 禁止, the default marked. It applies in every agent the
 * viewer uses; an agent's tools page can override it except a 禁止; a tool the org turned off or
 * denied is locked. Picking the default clears the setting, so it follows the org's default.
 * Saved together with 保存. One row per tool (the title and its select, `ToolPolicyList` without
 * checkboxes), grouped by what the tool declares: read-only tools (default 允许) apart from the
 * ones that may write (default 询问, an undeclared tool included).
 */
export function ConnectorPermissionsSheet({
  orgId,
  connector,
  onClose,
}: {
  orgId: string;
  connector: ConnectorDetail;
  onClose(): void;
}) {
  const t = useTranslations("connectors.permissions");
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const q = myToolPoliciesQuery(orgId, connector.id);
  const read = useQuery({ ...q, retryOnMount: retryOnMountOf(q.queryKey) });
  /** The viewer's edits by tool name (null: back to the default). */
  const [edits, setEdits] = useState<Record<string, ToolPolicy | null>>({});
  const [error, setError] = useState<string>();
  const save = useAppMutation({
    fn: (tools: Record<string, ToolPolicy | null>) => setMyToolPolicies(orgId, connector.id, tools),
    invalidates: () => [keys.org(orgId).connectorMyPolicies(connector.id)],
  });
  const tools = read.data?.tools ?? null;
  const effective = (x: MemberToolPolicy): ToolPolicy =>
    (x.name in edits ? edits[x.name] : x.policy) ?? x.defaultPolicy;
  const dirty = Object.keys(edits).length > 0;
  const label = (p: ToolPolicy) => t(p);
  /** A tool's row: its title (the key as hover text), its select, why it is locked. */
  const rowOf = (x: MemberToolPolicy, group: ToolPolicy): ToolPolicyRow => ({
    id: x.name,
    label: x.title ?? x.name,
    tooltip:
      x.title !== null ? `${x.name}${x.description ? ` · ${x.description}` : ""}` : x.description,
    checked: true,
    policy: x.locked !== null ? "deny" : effective(x),
    ...(x.locked !== null
      ? { locked: true, note: { text: t(`locked.${x.locked}`), tone: "warn" as const } }
      : x.defaultPolicy !== group
        ? { note: { text: t("default", { label: label(x.defaultPolicy) }) } }
        : {}),
  });
  /** Picking the default clears the setting; back to what is saved drops the edit. */
  const pick = (x: MemberToolPolicy | undefined, v: string) => {
    if (x === undefined) return;
    setEdits((cur) => {
      const next = v as ToolPolicy;
      const value = next === x.defaultPolicy ? null : next;
      const out = { ...cur };
      if (value === x.policy) delete out[x.name];
      else out[x.name] = value;
      return out;
    });
  };
  const onSave = async () => {
    setError(undefined);
    try {
      await save.mutateAsync(edits);
      toast.success(t("saved"));
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  return (
    <Sheet
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title={t("title", { name: connector.name })}
      mark={{ text: connector.name, image: connector.icon ?? null }}
      dirty={dirty}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("cancel")}
          </Button>
          <Button
            variant="primary"
            disabled={!dirty || save.isPending}
            loading={save.isPending}
            onClick={() => void onSave()}
          >
            {t("save")}
          </Button>
        </>
      }
    >
      <Stack gap={12}>
        <Text variant="prose" tone="muted">
          {t("hint")}
        </Text>
        {error !== undefined && <FormError message={error} />}
        {tools === null ? (
          read.error !== null ? (
            <FormError message={errorMessage(read.error)} />
          ) : (
            <Text variant="prose" tone="muted">
              {t("loading")}
            </Text>
          )
        ) : tools.length === 0 ? (
          <EmptyState size="panel" text={t("empty")} />
        ) : (
          (["allow", "ask"] as const).map((group) => {
            const members = tools.filter((x) => x.annotationPolicy === group);
            if (members.length === 0) return null;
            const title = t(group === "allow" ? "groups.read" : "groups.write");
            return (
              <Subsection
                key={group}
                variant="divided"
                title={title}
                count={members.length}
                description={t(group === "allow" ? "groups.readHint" : "groups.writeHint")}
              >
                <ToolPolicyList
                  label={title}
                  rows={members.map((x) => rowOf(x, group))}
                  policyOptions={POLICIES.map((p) => ({
                    value: p,
                    label: p === group ? t("defaultMark", { label: label(p) }) : label(p),
                  }))}
                  onPolicy={(name, v) =>
                    pick(
                      members.find((x) => x.name === name),
                      v,
                    )
                  }
                  disabled={save.isPending}
                  search={members.length > 8}
                />
              </Subsection>
            );
          })
        )}
      </Stack>
    </Sheet>
  );
}
