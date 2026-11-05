"use client";

import { type ActionRowProps, Callout, Card, Stack, Text } from "@capybara-hq/design";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { type ReactNode, useState } from "react";
import { type AgentDefinitionSave, type AgentWarning, updateAgent } from "../../lib/agents";
import { ApiClientError } from "../../lib/api";
import { keys } from "../../lib/query/keys";
import { useAppMutation } from "../../lib/query/mutation";
import { useErrorMessage } from "../../lib/use-error-message";
import { ErrorFrame } from "../ErrorFrame";
import { FormError } from "../form-error";
import { CONFLICT_CODES } from "./BasicsSection";
import { type AgentFormData, useAgentFormData } from "./form-data";
import { AgentSectionFrame, useAgentPage } from "./frame";

export type SaveResult = { saved: true } | { saved: false; error: unknown };

/** What {@link useDefinitionSave} gives a definition section. */
export interface DefinitionSave {
  pending: boolean;
  /** The last save's failure (null after a success, a discard or a reload). */
  error: unknown;
  /** The kernel's warnings after the last save. */
  warnings: AgentWarning[];
  /** Call on each edit: the first one takes the version the edit is made on. */
  begin(): void;
  /** Sends the definition with `expectedVersion`: saved, or the failure. */
  send(definition: AgentDefinitionSave): Promise<SaveResult>;
  /** Forgets the version and the error (after a discard). */
  clear(): void;
  /** Reads the agent again, then calls `after` (the section starts over from the newer version). */
  reload(after: () => void): Promise<void>;
}

/**
 * One definition section's save (agent profile design §3.2): `PATCH …/agents/:id` with the
 * section's definition and the version its first edit was made on, so a save over someone
 * else's newer version is a 409 with a reload, never a silent overwrite. A save invalidates the
 * agents list and the agent; it resolves once the agent was read again.
 */
export function useDefinitionSave(): DefinitionSave {
  const qc = useQueryClient();
  const { orgId, agent } = useAgentPage();
  const [base, setBase] = useState<number | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [warnings, setWarnings] = useState<AgentWarning[]>([]);
  const mutation = useAppMutation({
    fn: (input: { definition: AgentDefinitionSave; expectedVersion: number }) =>
      updateAgent(orgId, agent.id, input),
    invalidates: () => [keys.org(orgId).agents(), keys.org(orgId).agent(agent.id)],
  });
  const clear = () => {
    setBase(null);
    setError(null);
  };
  return {
    pending,
    error,
    warnings,
    begin: () => setBase((b) => b ?? agent.currentVersion),
    async send(definition) {
      setPending(true);
      setError(null);
      setWarnings([]);
      try {
        const r = await mutation.mutateAsync({
          definition,
          expectedVersion: base ?? agent.currentVersion,
        });
        setBase(null);
        setWarnings(r.warnings);
        return { saved: true };
      } catch (e) {
        setError(e);
        return { saved: false, error: e };
      } finally {
        setPending(false);
      }
    },
    clear,
    async reload(after) {
      await qc.refetchQueries({ queryKey: keys.org(orgId).agent(agent.id) });
      clear();
      setWarnings([]);
      after();
    },
  };
}

/**
 * Above a definition section's fields: the kernel's warnings after a save (a danger card), and a
 * failed save's error (a conflict offers the reload; `extra` lists lines no field shows).
 */
export function SaveFeedback({
  save,
  onReload,
  extra = [],
}: {
  save: DefinitionSave;
  onReload(): void;
  extra?: string[];
}) {
  const t = useTranslations("agents");
  const errorMessage = useErrorMessage();
  const { error, warnings } = save;
  return (
    <>
      {warnings.length > 0 && (
        <Card tone="danger" title={t("form.warningsTitle")}>
          <Stack gap={4}>
            {warnings.map((w) => (
              <Text key={w} tone="warn" icon="circle-alert">
                {t.has(`warnings.${w}`) ? t(`warnings.${w}`) : t("warnings.unknown", { code: w })}
              </Text>
            ))}
          </Stack>
        </Card>
      )}
      {error === null ? null : error instanceof ApiClientError && CONFLICT_CODES.has(error.code) ? (
        <Callout tone="fail" action={{ label: t("page.reload"), onSelect: onReload }}>
          {errorMessage(error)}
        </Callout>
      ) : (
        <FormError message={errorMessage(error)} extra={extra} />
      )}
    </>
  );
}

/** The options of {@link useSectionActionRow}'s row. */
export interface SectionRowOptions {
  unsaved: number;
  errors: number;
  pending: boolean;
  onDiscard(): void;
  onSave(): void;
  /** Save is off for another reason than "nothing changed" (no models to pick). */
  disabled?: boolean;
}

/**
 * A section's action row by the template's rule: only with changes, while saving, or after a
 * failure; Discard only with changes.
 */
export function useSectionActionRow(): (o: SectionRowOptions) => ActionRowProps | undefined {
  const t = useTranslations("agents");
  return (o) =>
    o.unsaved === 0 && !o.pending && o.errors === 0
      ? undefined
      : {
          unsaved: o.unsaved,
          errors: o.errors,
          ...(o.unsaved > 0 ? { cancel: { label: t("page.discard"), onSelect: o.onDiscard } } : {}),
          primary: {
            label: t("form.submit"),
            onSelect: o.onSave,
            loading: o.pending,
            disabled: o.pending || o.unsaved === 0 || o.disabled === true,
          },
        };
}

/**
 * A definition section with the agent form's reads (models, connectors, skills, sub-agent
 * lists): the section's loading frame until they answer, the error frame when a required one
 * failed, else `children` with the data.
 */
export function WithFormData({ children }: { children(data: AgentFormData): ReactNode }) {
  const { orgId, agent } = useAgentPage();
  const state = useAgentFormData(orgId, agent.id);
  if (state.kind === "error") return <ErrorFrame reset={state.retry} />;
  if (state.kind === "loading") return <AgentSectionFrame loading />;
  return <>{children(state.data)}</>;
}
