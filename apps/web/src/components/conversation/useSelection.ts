"use client";

import type { PickerProps } from "@capybara-hq/design";
import { useQuery } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useMemo, useState } from "react";
import {
  type Agent,
  EFFORTS,
  type Effort,
  findModel,
  type ModelInfo,
  type ProviderModels,
} from "../../lib/agents";
import type { ModelRef, Selection } from "../../lib/conversations";
import {
  chosenDeviceId,
  type Device,
  type DeviceList,
  deviceChoiceShown,
  deviceState,
} from "../../lib/devices";
import { extensionLabel } from "../../lib/extension-label";
import { retryOnMountOf } from "../../lib/query/client";
import { deviceProjectsQuery } from "../../lib/query/devices";
import { useDeviceName } from "../use-device-name";

export type { Effort } from "../../lib/agents";

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
            // the agent's default leads a long list with the current model (§6.16.2, §6.16.3)
            ...(sameRef(ref, agentModel) ? { tag: t("agentDefault"), pinned: true } : {}),
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
   * The device's project the first message binds the conversation to (project root §4.3);
   * undefined: 自由模式.
   */
  project: string | undefined;
  /**
   * Without a cloud sandbox, when none of the local devices can be used now (their
   * machines are offline): the first send goes without a device (any permission profile), and
   * this says why. Never set while the platform has a cloud sandbox (the kernel then makes or
   * uses the personal device).
   */
  unavailable?: string;
  /**
   * Undefined when the person has no device and cannot create one (no device provider is on in
   * the org): the composer then has no top strip. With no device but a provider, the picker
   * reads "No device" and offers only "New device".
   */
  picker: PickerProps | undefined;
  /**
   * The chosen device's project picker (project root §4.3, composer menus spec §6): 自由模式 and
   * the projects its current mode can read; undefined when the device offers none.
   */
  projectPicker?: PickerProps;
  /**
   * The new-device dialog the picker's "New device" opened (the Devices page's, `DeviceCreateDialog`):
   * the composer draws it while set.
   */
  create?: { onClose(): void };
};

/** A project item's id in the project picker; the bare prefix is 自由模式. */
const PROJECT_ITEM = "project:";

/**
 * The new conversation's device picker (environments design §4.1 item 2, §9): the person's
 * devices; the ones whose provider is gone (hint 不可用), whose files are lost (hint 文件已丢失;
 * 重建文件 on its page first) or whose machine is offline (hint 离线) shown but not selectable; a
 * connected one that is online says 在线. It starts on the last used device, else the
 * default, else the first usable one ({@link chosenDeviceId}). It shows when the platform has a
 * cloud sandbox or the person has a local device. Without a cloud sandbox and with every local
 * device offline, nothing is chosen and `unavailable` holds the reason the composer shows; the
 * first send then goes without a device.
 *
 * A second picker after it binds the conversation to a project (project root §4.3, composer menus
 * spec §6: the top strip reads device / project): 自由模式 (the default) and the chosen device's
 * projects its current mode can read. A device without projects, or one that does not support
 * them, offers no project picker (while its projects are read the picker stands disabled on
 * free mode, with a loading notice); another device drops the pick.
 *
 * With no device at all but a device provider on in the org ({@link canCreateDevice}), there is
 * nothing to pick: the button leads with the device icon and says "No device" (the first send goes
 * without one), and the menu holds only "New device" (the Devices page's new-device dialog, which
 * `create` asks the composer to draw) and the note.
 */
export function useDeviceChoice(orgId: string, list: DeviceList | undefined): DeviceChoice {
  const t = useTranslations("chat");
  const te = useTranslations("devices");
  const nameOf = useDeviceName();
  const [picked, setPicked] = useState<string | null>(null);
  /** The project picked, with the device it belongs to. */
  const [pickedProject, setPickedProject] = useState<{ device: string; name: string } | null>(null);
  const [creating, setCreating] = useState(false);
  const id = list === undefined ? undefined : chosenDeviceId(list, picked);
  // prefetched with the page for the device it starts on (the route's `then`)
  const projectsQ = deviceProjectsQuery(orgId, id ?? "");
  const projectsRead = useQuery({
    ...projectsQ,
    enabled: id !== undefined,
    retryOnMount: retryOnMountOf(projectsQ.queryKey),
  });
  const projects = projectsRead.data;
  // while the device's projects are read the project picker stands disabled on free mode, so it
  // does not pop in later; it is absent only once the read found none (or failed)
  const projectsLoading = id !== undefined && projectsRead.isPending;
  if (list === undefined || !deviceChoiceShown(list)) {
    return { deviceId: undefined, project: undefined, picker: undefined };
  }
  if (list.items.length === 0) {
    // nothing to pick: say what happens and offer the one next step (deviceChoiceShown: a
    // provider is on, so a device can be created)
    return {
      deviceId: undefined,
      project: undefined,
      picker: {
        label: t("pickDevice"),
        value: t("noDevice"),
        icon: "cpu",
        groups: [],
        action: { label: te("new"), icon: "plus", onSelect: () => setCreating(true) },
        note: t("deviceNote"),
        onPick: () => {},
      },
      ...(creating ? { create: { onClose: () => setCreating(false) } } : {}),
    };
  }
  const current = list.items.find((e) => e.id === id);
  const offered = projects?.supported === true ? projects.projects : [];
  const project =
    pickedProject !== null &&
    pickedProject.device === id &&
    offered.some((p) => p.name === pickedProject.name)
      ? pickedProject.name
      : undefined;
  const tagOf = (e: Device) => {
    const state = deviceState(e);
    if (state === "unavailable" || state === "filesLost" || state === "offline")
      return { disabled: true, tag: te(`state.${state}`) };
    if (state === "online") return { tag: te("state.online") };
    return {};
  };
  const name = current ? nameOf(current) : "—";
  return {
    deviceId: id,
    project,
    ...(id === undefined && list.providers.length === 0 ? { unavailable: t("deviceOffline") } : {}),
    picker: {
      label: t("pickDevice"),
      value: name,
      groups: [
        {
          items: list.items.map((e) => ({
            id: e.id,
            label: nameOf(e),
            checked: e.id === id,
            // no daily mode mark: the conversation's permission picker says what may run
            ...tagOf(e),
          })),
        },
      ],
      note: t("deviceNote"),
      onPick: (choice) => {
        // a project belongs to its device: another device (even back to this one) starts free
        if (choice !== id) setPickedProject(null);
        setPicked(choice);
      },
    },
    ...(projectsLoading
      ? {
          projectPicker: {
            label: t("projectGroup"),
            value: t("freeMode"),
            disabled: true,
            notice: t("projectsLoading"),
            groups: [],
            onPick: () => {},
          },
        }
      : id !== undefined && offered.length > 0
        ? {
            projectPicker: {
              label: t("projectGroup"),
              value: project ?? t("freeMode"),
              groups: [
                {
                  items: [
                    { id: PROJECT_ITEM, label: t("freeMode"), checked: project === undefined },
                    ...offered.map((p) => ({
                      id: `${PROJECT_ITEM}${p.name}`,
                      label: p.name,
                      checked: p.name === project,
                    })),
                  ],
                },
              ],
              onPick: (choice: string) => {
                const name = choice.slice(PROJECT_ITEM.length);
                setPickedProject(name === "" ? null : { device: id, name });
              },
            },
          }
        : {}),
  };
}

/**
 * An existing conversation's device, read only (the top strip's `locked` picker): its name,
 * 设备已删除 when the bound device is gone, nothing for a conversation with none bound.
 */
export function lockedDevicePicker(
  text: { label: string; hint: string; deleted: string },
  deviceId: string | null | undefined,
  device: Pick<Device, "name"> | null | undefined,
  nameOf: (e: Pick<Device, "name">) => string,
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

/**
 * An existing conversation's project, read only (project root §4.3: shown, never changed here):
 * the top strip's locked project picker, nothing for a conversation in 自由模式.
 */
export function lockedProjectPicker(
  text: { label: string; hint: string },
  project: string | null | undefined,
): PickerProps | undefined {
  if (!project) return undefined;
  return {
    label: text.label,
    value: project,
    locked: { hint: text.hint },
    groups: [],
    onPick: () => {},
  };
}
