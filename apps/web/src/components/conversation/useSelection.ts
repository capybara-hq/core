"use client";

import type { PickerProps } from "@capybara-hq/design";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useMemo, useState } from "react";
import { type Agent, findModel, type ModelInfo, type ProviderModels } from "../../lib/agents";
import type { ModelRef, Selection } from "../../lib/conversations";
import {
  type Device,
  type DeviceList,
  deviceNetworkOpen,
  devicePickable,
  deviceState,
} from "../../lib/devices";
import { extensionLabel } from "../../lib/extension-label";
import { useDeviceName } from "../use-device-name";

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
  /** A new conversation: the pick is its first message's, so the menus carry no "from the next
   * message on" note (acceptance 2026-11-07). */
  opts: { newConversation?: boolean } = {},
): SelectionView {
  const t = useTranslations("chat");
  const nextNote = opts.newConversation ? {} : { note: t("nextMessage") };
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

  const locale = useLocale() === "zh" ? "zh" : "en";
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
        label: extensionLabel({ name: p.provider, displayName: p.displayName }, locale),
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
  }, [providers, agentModel, model, t, locale]);

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
    ...nextNote,
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
          ...nextNote,
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

export type DeviceChoice = {
  /**
   * The device the first message binds the conversation to (none: no provider, or none
   * usable).
   */
  deviceId: string | undefined;
  /**
   * Without a cloud sandbox, when none of the local devices can be used now (their
   * machines are offline): sending must wait, and this says why. Never set while the platform has
   * a cloud sandbox (the kernel then makes or uses the personal device).
   */
  unavailable?: string;
  /**
   * Undefined without a sandbox provider and without a local device: the composer then
   * has no device picker.
   */
  picker: PickerProps | undefined;
};

/**
 * The new conversation's device picker (environments design §4.1 item 2, §9): the person's
 * devices; the ones whose provider is gone (hint 不可用), whose files are lost (hint 文件已丢失;
 * 重建文件 on its page first) or whose machine is offline (hint 离线) shown but not selectable; a
 * connected one that is online says 在线. It starts on the last used device, else the
 * default, else the first usable one. It shows when the platform has a cloud sandbox or the person
 * has a local device. Without a cloud sandbox and with every local device
 * offline, nothing is chosen and `unavailable` holds the reason the composer shows instead of
 * sending with no device.
 */
export function useDeviceChoice(list: DeviceList | undefined): DeviceChoice {
  const t = useTranslations("chat");
  const te = useTranslations("devices");
  const nameOf = useDeviceName();
  const [picked, setPicked] = useState<string | null>(null);
  if (list === undefined || !(list.cloudAvailable || list.items.some((e) => e.source === "local")))
    return { deviceId: undefined, picker: undefined };
  const usable = (id: string | null | undefined) =>
    list.items.find((e) => e.id === id && devicePickable(e))?.id;
  const id =
    usable(picked) ??
    usable(list.lastUsedId) ??
    usable(list.defaultId) ??
    list.items.find(devicePickable)?.id;
  const current = list.items.find((e) => e.id === id);
  const tagOf = (e: Device) => {
    const state = deviceState(e);
    if (state === "unavailable" || state === "filesLost" || state === "offline")
      return { disabled: true, tag: te(`state.${state}`) };
    return state === "online" ? { tag: te("state.online") } : {};
  };
  return {
    deviceId: id,
    ...(id === undefined && !list.cloudAvailable ? { unavailable: t("deviceOffline") } : {}),
    picker: {
      label: t("pickDevice"),
      value: current ? nameOf(current) : "—",
      groups: [
        {
          items: list.items.map((e) => ({
            id: e.id,
            label: nameOf(e),
            checked: e.id === id,
            ...tagOf(e),
            ...(deviceNetworkOpen(e) ? { badge: te("network.open") } : {}),
          })),
        },
      ],
      note: t("deviceNote"),
      onPick: setPicked,
    },
  };
}

/**
 * An existing conversation's device, read only (the composer's `locked` picker): its name,
 * 设备已删除 when the bound device is gone, nothing for a conversation with none bound.
 */
export function lockedDevicePicker(
  text: { label: string; hint: string; deleted: string },
  deviceId: string | null | undefined,
  device: Pick<Device, "name" | "demotedFrom"> | null | undefined,
  nameOf: (e: Pick<Device, "name" | "demotedFrom">) => string,
): PickerProps | undefined {
  if (!deviceId || device === undefined) return undefined;
  return {
    label: text.label,
    value: device === null ? text.deleted : nameOf(device),
    locked: { hint: text.hint },
    groups: [],
    onPick: () => {},
  };
}
