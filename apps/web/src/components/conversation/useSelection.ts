"use client";

import type { PickerProps } from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  type Agent,
  findModel,
  listModels,
  type ModelInfo,
  type ProviderModels,
} from "../../lib/agents";
import type { ModelRef, Selection } from "../../lib/conversations";

const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

const refId = (r: ModelRef) => `${r.provider}\u0000${r.model}`;
const sameRef = (a: ModelRef | null | undefined, b: ModelRef | null | undefined) =>
  a != null && b != null && a.provider === b.provider && a.model === b.model;

/** The `effort` values a model declares (its standard `effort` knob), in the standard order. */
export function declaredEfforts(m: ModelInfo | undefined): Effort[] {
  const p = m?.parameters.find((x) => x.standard === "effort" || x.key === "effort");
  if (p?.schema.type !== "string" || !("enum" in p.schema)) return [];
  const values = new Set(p.schema.enum);
  return EFFORTS.filter((e) => values.has(e));
}

/** The org's chat models (`GET /orgs/:orgId/models`); undefined while loading or unreadable. */
export function useModels(orgId: string): ProviderModels[] | undefined {
  const [providers, setProviders] = useState<ProviderModels[]>();
  useEffect(() => {
    let live = true;
    listModels(orgId).then(
      (r) => {
        if (live) setProviders(r.providers);
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [orgId]);
  return providers;
}

/** What a send carries: the switch picked since the last message (sent once). */
export type PendingSwitch = { model?: ModelRef; effort?: Effort };

export type SelectionView = {
  /** The model the next message runs on. */
  model: ModelRef | null;
  effort: string | null;
  pending: PendingSwitch;
  /**
   * The picks `p` went out with a message (sent or queued): clear them unless the person picked
   * again meanwhile, and keep showing them until the conversation's selection is read again.
   */
  sent(p: PendingSwitch): void;
  modelPicker: PickerProps;
  /** Undefined when the model declares no effort (the picker hides). */
  effortPicker: PickerProps | undefined;
  contextWindowOf(m: ModelRef): number | undefined;
  reasoningOf(m: ModelRef): boolean | undefined;
};

/**
 * The composer's model and effort (spec §5.2): what the conversation runs on (its `selection`, else
 * the agent's model and saved effort) plus the person's picks, which are kept here and sent with the
 * next message (`model` / `effort` on the message), so the log records the switch at send time. The
 * model list is the org's chat models grouped by provider, the agent's model first; the effort list
 * is exactly what the selected model declares.
 */
export function useSelection(
  providers: ProviderModels[] | undefined,
  agent: Agent | undefined,
  selection: Selection | undefined,
): SelectionView {
  const t = useTranslations("chat");
  const [pending, setPending] = useState<PendingSwitch>({});
  // The picks that just went out, shown until the next conversation read (`base` is the selection
  // object they were sent against), so the picker does not flicker back to the old model (m6).
  const [shown, setShown] = useState<{ pick: PendingSwitch; base: Selection | undefined }>();
  const sentPick = shown !== undefined && shown.base === selection ? shown.pick : {};
  const view: PendingSwitch = { ...sentPick, ...pending };
  const agentModel = agent?.definition.model ?? null;
  const agentEffort =
    typeof agent?.definition.modelParams?.effort === "string"
      ? agent.definition.modelParams.effort
      : null;
  const model = view.model ?? selection?.model ?? agentModel;
  const modelInfo = providers && model ? findModel(providers, model) : undefined;
  const efforts = declaredEfforts(modelInfo);
  const defaultEffort = (() => {
    const p = modelInfo?.parameters.find((x) => x.standard === "effort" || x.key === "effort");
    return typeof p?.default === "string" ? p.default : null;
  })();
  // A model picked now resets the effort to the model's default unless an effort is picked too.
  const effort =
    view.effort ??
    (view.model !== undefined
      ? defaultEffort
      : (selection?.effort ?? (sameRef(model, agentModel) ? agentEffort : null) ?? defaultEffort));

  const label = (r: ModelRef | null) =>
    r === null ? "—" : ((providers && findModel(providers, r)?.displayName) ?? r.model);

  const groups = useMemo(() => {
    const list = [...(providers ?? [])];
    // The agent's provider first, and its model first within it.
    list.sort((a, b) =>
      a.provider === agentModel?.provider ? -1 : b.provider === agentModel?.provider ? 1 : 0,
    );
    return list.map((p) => {
      const models = [...p.models].sort((a, b) =>
        agentModel !== null && p.provider === agentModel.provider && a.id === agentModel.model
          ? -1
          : agentModel !== null && p.provider === agentModel.provider && b.id === agentModel.model
            ? 1
            : 0,
      );
      return {
        label: p.provider,
        items: models.map((m) => {
          const ref = { provider: p.provider, model: m.id };
          return {
            id: refId(ref),
            label: m.displayName || m.id,
            ...(sameRef(ref, agentModel) ? { tag: t("agentDefault") } : {}),
            checked: sameRef(ref, model),
          };
        }),
      };
    });
  }, [providers, agentModel, model, t]);

  const pickModel = useCallback(
    (id: string) => {
      for (const p of providers ?? []) {
        for (const m of p.models) {
          const ref = { provider: p.provider, model: m.id };
          if (refId(ref) === id) {
            setPending({ model: ref });
            return;
          }
        }
      }
    },
    [providers],
  );

  const modelPicker: PickerProps = {
    label: t("pickModel"),
    value: label(model),
    groups,
    note: t("nextMessage"),
    disabled: providers === undefined,
    onPick: pickModel,
  };
  const effortPicker: PickerProps | undefined =
    efforts.length === 0
      ? undefined
      : {
          label: t("pickEffort"),
          value: effort !== null ? t(`effort.${effort as Effort}`) : t("effortDefault"),
          groups: [
            {
              items: efforts.map((e) => ({
                id: e,
                label: t(`effort.${e}`),
                checked: e === effort,
              })),
            },
          ],
          note: t("nextMessage"),
          onPick: (id) => setPending((p) => ({ ...p, effort: id as Effort })),
        };

  return {
    model,
    effort,
    pending,
    sent: useCallback(
      (p: PendingSwitch) => {
        setPending((cur) => (cur.model === p.model && cur.effort === p.effort ? {} : cur));
        setShown({ pick: p, base: selection });
      },
      [selection],
    ),
    modelPicker,
    effortPicker,
    contextWindowOf: useCallback(
      (m: ModelRef) => (providers ? findModel(providers, m)?.contextWindow : undefined),
      [providers],
    ),
    reasoningOf: useCallback(
      (m: ModelRef) => (providers ? findModel(providers, m)?.capabilities.reasoning : undefined),
      [providers],
    ),
  };
}
