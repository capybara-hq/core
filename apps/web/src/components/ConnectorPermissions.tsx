"use client";

import {
  Button,
  ItemList,
  ItemListItem,
  Segmented,
  Sheet,
  Stack,
  Text,
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
 * Saved together with 保存.
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
        ) : (
          <ItemList label={t("listLabel")} empty={t("empty")}>
            {tools.map((x) => (
              <ItemListItem
                key={x.name}
                title={x.title ?? x.name}
                code={x.name}
                meta={
                  x.locked !== null ? (
                    <Text variant="small" tone="warn">
                      {t(`locked.${x.locked}`)}
                    </Text>
                  ) : (
                    <Text variant="small" tone="muted">
                      {t("default", { label: label(x.defaultPolicy) })}
                    </Text>
                  )
                }
              >
                {x.locked === null && (
                  <Segmented
                    label={x.title ?? x.name}
                    density="dense"
                    value={effective(x)}
                    options={POLICIES.map((p) => ({
                      value: p,
                      label:
                        p === x.defaultPolicy ? t("defaultMark", { label: label(p) }) : label(p),
                    }))}
                    onChange={(v) =>
                      setEdits((cur) => {
                        const next = v as ToolPolicy;
                        // the default clears the setting; back to what is saved drops the edit
                        const value = next === x.defaultPolicy ? null : next;
                        const out = { ...cur };
                        if (value === x.policy) delete out[x.name];
                        else out[x.name] = value;
                        return out;
                      })
                    }
                  />
                )}
              </ItemListItem>
            ))}
          </ItemList>
        )}
      </Stack>
    </Sheet>
  );
}
