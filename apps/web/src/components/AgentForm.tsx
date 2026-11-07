"use client";

import {
  AVATAR_PRESET_IDS,
  AVATAR_UPLOAD_ACCEPT,
  AvatarPicker,
  type AvatarValue,
  Field,
  FormSection,
  Input,
  type PresetId,
  Select,
  Stack,
} from "@capybara-hq/design";
import { useQuery } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import {
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  type Agent,
  type AgentVisibility,
  createAgent,
  type ProviderModels,
  updateAgentProfile,
  uploadAvatar,
} from "../lib/agents";
import { ApiClientError } from "../lib/api";
import { cropAvatar } from "../lib/avatar-crop";
import { labelLocale, modelLabel } from "../lib/extension-label";
import { retryOnMountOf } from "../lib/query/client";
import { attachmentLimitsQuery } from "../lib/query/conversation";
import { keys } from "../lib/query/keys";
import { useAppMutation } from "../lib/query/mutation";
import { useErrorMessage } from "../lib/use-error-message";
import { decodeModel as decode, encodeModel as encode } from "./agent/definition-parts";
import type { AgentFormData } from "./agent/form-data";
import { FormError } from "./form-error";

const VISIBILITIES = ["private", "org"] as const satisfies readonly AgentVisibility[];
const NAME_MAX = 80;

/** A random preset for a new agent's avatar (mirrors the kernel's `randomPreset`). */
const randomPreset = (random: () => number = Math.random): PresetId =>
  AVATAR_PRESET_IDS[Math.floor(random() * AVATAR_PRESET_IDS.length)] as PresetId;
/** Enter in these single-line inputs saves (the form has no native submit button). */
const ENTER_SUBMITS = new Set(["text", "search", "email", "url", "tel", "password", "number"]);

/** What {@link useAgentForm} gives the page to put in FormPage (sections, ActionRow). */
export type AgentFormView = {
  /** The form's FormSection, FormPage's children. */
  sections: ReactNode;
  /** ActionRow: the number of filled-in fields and of errors. */
  unsaved: number;
  errors: number;
  submit(): void;
  pending: boolean;
  canSubmit: boolean;
};

/**
 * What a create ends with: the new agent, and whether its picked image could not be uploaded (the
 * agent exists with its preselected preset; its page shows the error in Basics).
 */
export type AgentCreated = { agent: Agent; uploadFailed: boolean };

/**
 * The create form of `/agents/new` (agent profile design §2.4): the avatar (a random preset is
 * preselected; another preset or an upload), the name, the model and the visibility, nothing else.
 * The prompt starts from the kernel's default `AGENTS.md` (the request carries neither
 * `instructions` nor `instructionFiles`); everything else is set on the agent page. A picked upload
 * needs the agent's id: the agent is created with the preselected preset, then the image is
 * uploaded and saved into the profile.
 */
export function useAgentForm(
  orgId: string,
  onDone: (created: AgentCreated) => void,
  data: AgentFormData,
): AgentFormView {
  const t = useTranslations("agents");
  const tp = useTranslations("agents.page");
  const locale = useLocale();
  const lang = labelLocale(locale);
  const errorMessage = useErrorMessage();
  const providers: ProviderModels[] = data.providers;
  const options = providers.flatMap((p) =>
    p.models.map((m) => ({
      value: encode({ provider: p.provider, model: m.id }),
      label: modelLabel(
        { name: p.provider, displayName: p.displayName },
        m.displayName || m.id,
        lang,
      ),
    })),
  );
  const noModels = options.length === 0;

  const [name, setName] = useState("");
  // No org default chat model exists today: the form preselects the first available model.
  const [model, setModel] = useState(options[0]?.value ?? "");
  const [visibility, setVisibility] = useState<AgentVisibility>("private");
  // The preselected preset: kept while an upload is picked, so a failed upload leaves a real
  // avatar. It is drawn after mount, so the server's paint and the first client render agree.
  const [preset, setPreset] = useState<PresetId | null>(null);
  useEffect(() => setPreset((p) => p ?? randomPreset()), []);
  const [picked, setPicked] = useState<{ blob: Blob; src: string } | null>(null);
  const [uploadError, setUploadError] = useState<string>();
  const [storageOff, setStorageOff] = useState(false);
  const [cropping, setCropping] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [nameError, setNameError] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  // FormPage's create mode focuses the first field (the avatar); the name is the one required
  // field, so it takes the focus once FormPage's own effect has run.
  useEffect(() => {
    queueMicrotask(() =>
      formRef.current?.querySelector<HTMLInputElement>('input[name="name"]')?.focus(),
    );
  }, []);
  const pickedSrc = useRef<string | undefined>(undefined);
  useEffect(() => () => revoke(pickedSrc.current), []);

  const limitsQ = attachmentLimitsQuery(orgId);
  const limits = useQuery({ ...limitsQ, retryOnMount: retryOnMountOf(limitsQ.queryKey) });
  const uploadOff = storageOff || limits.data?.available === false;

  // A save invalidates the agents list, the agent and the org's readiness (a first agent makes it
  // ready).
  const create = useAppMutation({
    fn: (input: Parameters<typeof createAgent>[1]) => createAgent(orgId, input),
    invalidates: (_, r) => [
      keys.org(orgId).agents(),
      keys.org(orgId).agent(r.agent.id),
      keys.org(orgId).readiness(),
    ],
  });
  // The picked image: register and send it, then name it in the profile (the agent's own profile
  // answer is the new truth, so the lists are read again).
  const saveUpload = useAppMutation({
    fn: async ({ agent, blob }: { agent: Agent; blob: Blob }) => {
      const { uploadId } = await uploadAvatar(orgId, agent.id, blob);
      return updateAgentProfile(orgId, agent.id, {
        avatar: { kind: "upload", uploadId },
        expectedUpdatedAt: agent.profile.updatedAt,
      });
    },
    invalidates: (v) => [keys.org(orgId).agents(), keys.org(orgId).agent(v.agent.id)],
  });

  function pick(next: PresetId) {
    revoke(pickedSrc.current);
    pickedSrc.current = undefined;
    setPicked(null);
    setUploadError(undefined);
    setPreset(next);
  }

  async function onUpload(file: File) {
    setUploadError(undefined);
    // the picker's `accept` is a hint only: a dropped or forced file is checked here
    if (!AVATAR_UPLOAD_ACCEPT.split(",").includes(file.type)) {
      setUploadError(tp("uploadType"));
      return;
    }
    setCropping(true);
    try {
      const blob = await cropAvatar(file);
      revoke(pickedSrc.current);
      const src = typeof URL.createObjectURL === "function" ? URL.createObjectURL(blob) : undefined;
      pickedSrc.current = src;
      setPicked({ blob, src: src ?? "" });
    } catch {
      setUploadError(tp("uploadFailed"));
    } finally {
      setCropping(false);
    }
  }

  const pickerValue: AvatarValue =
    picked !== null && picked.src !== ""
      ? { kind: "image", src: picked.src }
      : preset === null
        ? null
        : { kind: "preset", id: preset };

  // The primary waits for a name (spec §5.3); Enter in the name field still says what is missing.
  const canSubmit = !pending && !cropping && !noModels && name.trim() !== "";

  async function save() {
    if (pending || cropping || noModels) return;
    const trimmed = name.trim();
    setNameError(trimmed === "");
    if (trimmed === "") return;
    const main = decode(model);
    if (main === null) return;
    setPending(true);
    setError(undefined);
    try {
      const res = await create.mutateAsync({
        definition: { name: trimmed, model: main },
        visibility,
        profile: { avatar: { kind: "preset", id: preset ?? randomPreset() } },
      });
      let uploadFailed = false;
      if (picked !== null) {
        try {
          await saveUpload.mutateAsync({ agent: res.agent, blob: picked.blob });
        } catch (e) {
          // the agent exists: its page shows the error in Basics
          uploadFailed = true;
          if (e instanceof ApiClientError && e.code === "storage.unavailable") setStorageOff(true);
        }
      }
      onDone({ agent: res.agent, uploadFailed });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(false);
    }
  }

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    void save();
  }

  function onKeyDown(e: KeyboardEvent<HTMLFormElement>) {
    const el = e.target;
    if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
    if (!(el instanceof HTMLInputElement) || !ENTER_SUBMITS.has(el.type)) return;
    e.preventDefault();
    void save();
  }

  const errors = (nameError ? 1 : 0) + (uploadError !== undefined ? 1 : 0);
  const unsaved = [name.trim() !== "", visibility !== "private", picked !== null].filter(
    Boolean,
  ).length;

  const sections = (
    <form ref={formRef} method="post" onSubmit={onSubmit} onKeyDown={onKeyDown} noValidate>
      <Stack gap={16}>
        {error !== undefined && <FormError message={error} />}
        <FormSection
          id="basic"
          title={t("form.basicSection")}
          description={t("form.basicSectionHint")}
        >
          <Stack gap={4}>
            <AvatarPicker
              value={pickerValue}
              label={tp("avatarLabel")}
              disabled={pending || cropping}
              onChange={(v) => {
                if (v?.kind === "preset") pick(v.id);
              }}
              {...(uploadOff
                ? { uploadOffReason: tp("uploadOff") }
                : { onUpload: (f: File) => void onUpload(f) })}
            />
            {uploadError !== undefined && <FormError message={uploadError} />}
          </Stack>
          <Field
            label={t("form.nameLabel")}
            required
            count={{ value: name.length, max: NAME_MAX }}
            {...(nameError ? { error: t("form.nameRequired") } : {})}
          >
            <Input
              name="name"
              maxLength={NAME_MAX}
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                if (e.target.value.trim() !== "") setNameError(false);
              }}
            />
          </Field>
          <Field
            label={t("form.modelLabel")}
            required
            {...(noModels ? { error: t("form.noModels") } : {})}
          >
            <Select
              name="model"
              disabled={noModels}
              value={model}
              onChange={(e) => setModel(e.target.value)}
              options={options}
            />
          </Field>
          <Field label={t("form.visibilityLabel")}>
            <Select
              name="visibility"
              value={visibility}
              onChange={(e) => setVisibility(e.target.value as AgentVisibility)}
              options={VISIBILITIES.map((v) => ({ value: v, label: t(`form.visibility.${v}`) }))}
            />
          </Field>
        </FormSection>
      </Stack>
    </form>
  );

  return { sections, unsaved, errors, submit: () => void save(), pending, canSubmit };
}

function revoke(src: string | undefined) {
  if (src !== undefined && typeof URL.revokeObjectURL === "function") URL.revokeObjectURL(src);
}

/** The create form while its reads are on the way: its one section with the field layout. */
export function AgentFormLoading() {
  const t = useTranslations("agents");
  return (
    <Stack gap={16}>
      <FormSection
        id="basic"
        title={t("form.basicSection")}
        description={t("form.basicSectionHint")}
        // the avatar tiles (ten presets and the upload tile), the name with its counter line,
        // the model and the visibility
        loading={{
          fields: [
            { control: "radios", options: 11 },
            { control: "input", help: true },
            { control: "select" },
            { control: "select" },
          ],
        }}
      />
    </Stack>
  );
}
