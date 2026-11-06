"use client";

import {
  AVATAR_UPLOAD_ACCEPT,
  AvatarPicker,
  type AvatarValue,
  Callout,
  Checkbox,
  Field,
  FormSection,
  Input,
  KeyValue,
  Select,
  Stack,
  Text,
  Textarea,
  versionLabel,
} from "@capybara-hq/design";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { Link, useRouter } from "../../i18n/navigation";
import {
  type Agent,
  type AgentAvatar,
  type AgentDefinitionSave,
  type AgentVisibility,
  avatarValue,
  type ProfileInput,
  updateAgent,
  uploadAvatar,
} from "../../lib/agents";
import { ApiClientError } from "../../lib/api";
import { cropAvatar } from "../../lib/avatar-crop";
import { retryOnMountOf } from "../../lib/query/client";
import { attachmentLimitsQuery } from "../../lib/query/conversation";
import { keys } from "../../lib/query/keys";
import { membersQuery } from "../../lib/query/members";
import { useAppMutation, useUpdateProfile } from "../../lib/query/mutation";
import { useErrorMessage } from "../../lib/use-error-message";
import { templateHref } from "../AgentTemplateCards";
import { FormError } from "../form-error";
import { savedDefinition } from "./definition-parts";
import { AgentSectionFrame, useAgentPage } from "./frame";
import { PendingConnectorsPlain } from "./PendingConnectorsNotice";
import { useSectionDraft } from "./useSectionDraft";

const NAME_MAX = 80;
const DESCRIPTION_MAX = 500;
const VISIBILITIES = ["private", "org", "members"] as const satisfies readonly AgentVisibility[];
/** The kernel's answers that mean someone else saved first: the section offers a reload. */
export const CONFLICT_CODES = new Set(["agent.profile_conflict", "agent.version_conflict"]);

/** The profile part of Basics (saved with `PATCH …/profile`). */
type ProfilePart = { avatar: AgentAvatar; description: string };
/** The agent part of Basics (the agent PATCH: the name is in the definition). */
type AgentPart = { name: string; visibility: AgentVisibility; memberIds: string[] };

const profilePartOf = (a: Agent): ProfilePart => ({
  avatar: a.profile.avatar,
  description: a.profile.description,
});
const agentPartOf = (a: Agent): AgentPart => ({
  name: a.definition.name,
  visibility: a.visibility,
  memberIds: a.memberIds ?? [],
});
const sameJson = (x: unknown, y: unknown) => JSON.stringify(x) === JSON.stringify(y);

/** The saved definition with only the name changed (see {@link savedDefinition}). */
const definitionWithName = (agent: Agent, name: string): AgentDefinitionSave => ({
  ...savedDefinition(agent),
  name,
});

/** A failure of one of Basics' two saves: a conflict offers the reload. */
function SaveError({ error, onReload }: { error: unknown; onReload(): void }) {
  const t = useTranslations("agents.page");
  const errorMessage = useErrorMessage();
  if (error instanceof ApiClientError && CONFLICT_CODES.has(error.code)) {
    return (
      <Callout tone="fail" action={{ label: t("reload"), onSelect: onReload }}>
        {errorMessage(error)}
      </Callout>
    );
  }
  return <FormError message={errorMessage(error)} />;
}

/**
 * 基本信息 Basics (agent profile design §3.2): avatar, name, description, visibility and members.
 * One Save makes up to two requests: the profile (avatar, description) and the agent PATCH (name,
 * visibility, members, with `expectedVersion`). Each part keeps its own draft: when one request
 * fails, the other part's saved changes stay and only the failed part's edits are kept. An upload
 * is cropped square in the browser, uploaded, and saved as `{ kind: "upload", uploadId }`.
 */
export function BasicsSection() {
  const { editable } = useAgentPage();
  return editable ? <BasicsEdit /> : <BasicsReadOnly />;
}

/**
 * 「由模板 <name> v<version> 创建」 (ruling P4-8): the template's name links to it while it is
 * still usable in the org (`available`), else it is plain text; nothing for an agent made
 * otherwise.
 */
export function Provenance({ agent }: { agent: Agent }) {
  const t = useTranslations("agents.page");
  const from = agent.createdFrom;
  if (from === undefined || from === null) return null;
  return (
    <span data-provenance="">
      <Text variant="small" tone="muted">
        {t.rich("provenance", {
          name: from.name,
          version: versionLabel(String(from.version)),
          template: (chunks) =>
            from.available === true ? (
              <Link href={templateHref(from.templateId)}>{chunks}</Link>
            ) : (
              chunks
            ),
        })}
      </Text>
    </span>
  );
}

function BasicsReadOnly() {
  const t = useTranslations("agents");
  const { agent } = useAgentPage();
  return (
    <AgentSectionFrame>
      <FormSection id="basics" title={t("page.sections.basics")}>
        <Text tone="muted">{t("readOnly")}</Text>
        <Provenance agent={agent} />
        <PendingConnectorsPlain agent={agent} />
        <KeyValue
          rows={[
            { k: t("form.nameLabel"), v: agent.definition.name },
            ...(agent.profile.description !== ""
              ? [{ k: t("page.descriptionLabel"), v: agent.profile.description }]
              : []),
            { k: t("form.visibilityLabel"), v: t(`scope.${agent.visibility}`) },
          ]}
        />
      </FormSection>
    </AgentSectionFrame>
  );
}

function BasicsEdit() {
  const t = useTranslations("agents");
  const qc = useQueryClient();
  const errorMessage = useErrorMessage();
  const { orgId, agent } = useAgentPage();
  const router = useRouter();
  const agentId = agent.id;
  const profile = useSectionDraft(profilePartOf(agent));
  const basic = useSectionDraft(agentPartOf(agent));
  // What each part's edits were made on: a save over a newer one is a 409 with a reload.
  const [profileBase, setProfileBase] = useState<string | null>(null);
  const [versionBase, setVersionBase] = useState<number | null>(null);
  const [preview, setPreview] = useState<{ uploadId: string; src: string } | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [storageOff, setStorageOff] = useState(false);
  const [pending, setPending] = useState(false);
  const [profileError, setProfileError] = useState<unknown>(null);
  const [agentError, setAgentError] = useState<unknown>(null);
  const [nameError, setNameError] = useState(false);
  useEffect(() => () => (preview ? URL.revokeObjectURL(preview.src) : undefined), [preview]);
  // Landing here from `/agents/new` after its picked image could not be uploaded.
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("avatar") !== "failed") return;
    setUploadError(t("page.createUploadFailed"));
    // the notice is shown once: a reload does not bring it back
    router.replace(`/agents/${encodeURIComponent(agentId)}?s=basics`);
  }, [t, router, agentId]);

  const limitsQ = attachmentLimitsQuery(orgId);
  const limits = useQuery({ ...limitsQ, retryOnMount: retryOnMountOf(limitsQ.queryKey) });
  const membersQ = membersQuery(orgId);
  const members = useQuery({ ...membersQ, retryOnMount: retryOnMountOf(membersQ.queryKey) });
  const updateProfile = useUpdateProfile(orgId, agent.id);
  // the upload only registers a file: the profile save that names it changes the agent
  const upload = useAppMutation({
    fn: (square: Blob) => uploadAvatar(orgId, agent.id, square),
    invalidates: () => [],
  });
  const saveAgent = useAppMutation({
    fn: (input: {
      definition?: AgentDefinitionSave;
      visibility?: AgentVisibility;
      memberIds?: string[];
      expectedVersion: number;
    }) => updateAgent(orgId, agent.id, input),
    // a visibility or members change can change what the org's readiness counts
    invalidates: (v) => [
      keys.org(orgId).agents(),
      keys.org(orgId).agent(agent.id),
      ...(v.visibility !== undefined || v.memberIds !== undefined
        ? [keys.org(orgId).readiness()]
        : []),
    ],
  });

  const editProfile = (next: Partial<ProfilePart>) => {
    if (!profile.dirty) setProfileBase(agent.profile.updatedAt);
    profile.set(next);
  };
  const editBasic = (next: Partial<AgentPart>) => {
    if (!basic.dirty) setVersionBase(agent.currentVersion);
    basic.set(next);
  };

  const uploadOff = storageOff || limits.data?.available === false;
  async function onUpload(file: File) {
    setUploadError(null);
    // the picker's `accept` is a hint only: a dropped or forced file is checked here
    if (!AVATAR_UPLOAD_ACCEPT.split(",").includes(file.type)) {
      setUploadError(t("page.uploadType"));
      return;
    }
    setUploading(true);
    try {
      const square = await cropAvatar(file);
      const { uploadId } = await upload.mutateAsync(square);
      setPreview(
        typeof URL.createObjectURL === "function"
          ? { uploadId, src: URL.createObjectURL(square) }
          : null,
      );
      editProfile({ avatar: { kind: "upload", uploadId } });
    } catch (e) {
      if (e instanceof ApiClientError && e.code === "storage.unavailable") setStorageOff(true);
      else setUploadError(e instanceof ApiClientError ? errorMessage(e) : t("page.uploadFailed"));
    } finally {
      setUploading(false);
    }
  }

  const d = profile.draft;
  const b = basic.draft;
  /** What the picker shows: a preset, the new upload's preview, or the saved image. */
  const pickerValue: AvatarValue =
    d.avatar === null
      ? null
      : d.avatar.kind === "preset"
        ? d.avatar
        : d.avatar.kind === "upload" && preview?.uploadId === d.avatar.uploadId
          ? { kind: "image", src: preview.src }
          : avatarValue(agent, orgId);

  const savedProfile = profilePartOf(agent);
  const savedBasic = agentPartOf(agent);
  const changed = {
    avatar: !sameJson(d.avatar, savedProfile.avatar),
    description: d.description !== savedProfile.description,
    name: b.name.trim() !== savedBasic.name,
    visibility: b.visibility !== savedBasic.visibility,
    members: b.visibility === "members" && !sameJson(b.memberIds, savedBasic.memberIds),
  };
  const unsaved = Object.values(changed).filter(Boolean).length;
  const dirty = profile.dirty || basic.dirty;

  async function save() {
    if (pending || uploading) return;
    const name = b.name.trim();
    setNameError(name === "");
    if (name === "") return;
    const profileInput: ProfileInput = {
      // an `external` avatar is migrated data: never written back
      ...(changed.avatar && d.avatar?.kind !== "external" ? { avatar: d.avatar } : {}),
      ...(changed.description ? { description: d.description } : {}),
    };
    const sendProfile = Object.keys(profileInput).length > 0;
    const sendAgent = changed.name || changed.visibility || changed.members;
    setPending(true);
    setProfileError(null);
    setAgentError(null);
    // The profile first, then the agent: the agent PATCH's refetch then reads the new profile, so
    // a slow refetch can never write the old profile over the one the profile save cached.
    const [p] = await Promise.allSettled([
      sendProfile
        ? updateProfile.mutateAsync({
            ...profileInput,
            expectedUpdatedAt: profileBase ?? agent.profile.updatedAt,
          })
        : Promise.resolve(null),
    ]);
    const [a] = await Promise.allSettled([
      sendAgent
        ? saveAgent.mutateAsync({
            ...(changed.name ? { definition: definitionWithName(agent, name) } : {}),
            ...(changed.visibility ? { visibility: b.visibility } : {}),
            ...(b.visibility === "members" && (changed.members || changed.visibility)
              ? { memberIds: b.memberIds }
              : {}),
            expectedVersion: versionBase ?? agent.currentVersion,
          })
        : Promise.resolve(null),
    ]);
    // each part on its own: a saved part follows the saved agent, a failed one keeps its edits
    if (p.status === "fulfilled") {
      profile.reset();
      setProfileBase(null);
    } else setProfileError(p.reason);
    if (a.status === "fulfilled") {
      basic.reset();
      setVersionBase(null);
    } else setAgentError(a.reason);
    setPending(false);
  }

  function discard() {
    profile.reset();
    basic.reset();
    setProfileBase(null);
    setVersionBase(null);
    setProfileError(null);
    setAgentError(null);
    setNameError(false);
    setUploadError(null);
  }

  /** Someone else saved first: read the agent again and start over from it. */
  async function reload() {
    await qc.refetchQueries({ queryKey: keys.org(orgId).agent(agent.id) });
    discard();
  }

  const orgMembers = (members.data?.members ?? []).filter((m) => !m.anonymous);
  const errors = (nameError ? 1 : 0) + (profileError ? 1 : 0) + (agentError ? 1 : 0);
  // the template's rule: the action row only with changes (or while saving, or after a failure)
  const showRow = dirty || pending || errors > 0;
  return (
    <AgentSectionFrame
      dirty={dirty}
      actionRow={
        showRow
          ? {
              unsaved,
              errors,
              ...(dirty ? { cancel: { label: t("page.discard"), onSelect: discard } } : {}),
              primary: {
                label: t("form.submit"),
                onSelect: () => void save(),
                loading: pending,
                disabled: pending || uploading || !dirty || b.name.trim() === "",
              },
            }
          : undefined
      }
    >
      <Stack gap={16}>
        {profileError ? <SaveError error={profileError} onReload={() => void reload()} /> : null}
        {agentError ? <SaveError error={agentError} onReload={() => void reload()} /> : null}
        <FormSection id="basics" title={t("page.sections.basics")}>
          <Provenance agent={agent} />
          <Stack gap={4}>
            <AvatarPicker
              value={pickerValue}
              label={t("page.avatarLabel")}
              disabled={pending || uploading}
              onChange={(v) => {
                if (v?.kind === "preset") editProfile({ avatar: v });
              }}
              {...(uploadOff
                ? { uploadOffReason: t("page.uploadOff") }
                : { onUpload: (f: File) => void onUpload(f) })}
            />
            {uploadError ? <FormError message={uploadError} /> : null}
          </Stack>
          <Field
            label={t("form.nameLabel")}
            required
            count={{ value: b.name.length, max: NAME_MAX }}
            {...(nameError ? { error: t("form.nameRequired") } : {})}
          >
            <Input
              name="name"
              disabled={pending}
              maxLength={NAME_MAX}
              value={b.name}
              onChange={(e) => {
                editBasic({ name: e.target.value });
                if (e.target.value.trim() !== "") setNameError(false);
              }}
            />
          </Field>
          <Field
            label={t("page.descriptionLabel")}
            optional
            help={t("page.descriptionHelp")}
            count={{ value: d.description.length, max: DESCRIPTION_MAX }}
          >
            <Textarea
              name="description"
              disabled={pending}
              rows={3}
              maxLength={DESCRIPTION_MAX}
              value={d.description}
              onChange={(e) => editProfile({ description: e.target.value })}
            />
          </Field>
          <Field label={t("form.visibilityLabel")}>
            <Select
              name="visibility"
              disabled={pending}
              value={b.visibility}
              onChange={(e) => editBasic({ visibility: e.target.value as AgentVisibility })}
              options={VISIBILITIES.map((v) => ({ value: v, label: t(`form.visibility.${v}`) }))}
            />
          </Field>
          {b.visibility === "members" && (
            // biome-ignore lint/a11y/useSemanticElements: fieldset 带浏览器默认边框与内边距，apps/web 不能写样式；用 role=group 分组
            <div role="group" aria-label={t("page.membersLabel")}>
              <Stack gap={4}>
                <Text variant="small" tone="muted">
                  {t("page.membersLabel")}
                </Text>
                {members.data === undefined ? (
                  <Text variant="small" tone="faint">
                    {members.error === null ? t("page.membersLoading") : t("page.membersFailed")}
                  </Text>
                ) : (
                  orgMembers.map((m) => (
                    <Checkbox
                      key={m.account.id}
                      label={m.account.displayName}
                      checked={b.memberIds.includes(m.account.id)}
                      disabled={pending}
                      onChange={(on) =>
                        editBasic({
                          memberIds: on
                            ? [...b.memberIds, m.account.id]
                            : b.memberIds.filter((x) => x !== m.account.id),
                        })
                      }
                    />
                  ))
                )}
              </Stack>
            </div>
          )}
        </FormSection>
      </Stack>
    </AgentSectionFrame>
  );
}
