"use client";

import {
  AVATAR_UPLOAD_ACCEPT,
  Avatar,
  Button,
  Field,
  FileButton,
  FormSection,
  Icon,
  Input,
  SettingsPage,
  Stack,
  Text,
  useToast,
} from "@capybara-hq/design";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { FormError } from "../../../../components/form-error";
import { ACCOUNT_HOME, useAccountNav } from "../../../../components/settings-nav";
import { usePagePath } from "../../../../components/shell/path";
import { ApiClientError } from "../../../../lib/api";
import { cropAvatar } from "../../../../lib/avatar-crop";
import { patchProfile, uploadAccountAvatar } from "../../../../lib/profile";
import { keys } from "../../../../lib/query/keys";
import { cachedMembersKeys } from "../../../../lib/query/members";
import { useAppMutation } from "../../../../lib/query/mutation";
import { meQuery } from "../../../../lib/query/shell";
import type { Account } from "../../../../lib/session";
import { useErrorMessage } from "../../../../lib/use-error-message";

/** The kernel's limit on a display name, in code points. */
const NAME_MAX = 64;

const lengthOf = (s: string) => [...s].length;

/**
 * `/account/profile`: the person's name and avatar (SettingsPage). An avatar change saves at once
 * (a picked image is cropped square, uploaded, then named in the profile; 移除 sends `null`); the
 * name saves from the action row. Both refresh `me` and every cached members list.
 */
export default function ProfileView() {
  const me = useQuery(meQuery()).data;
  if (me === undefined) return null;
  return <ProfileForm account={me.account} />;
}

function ProfileForm({ account }: { account: Account }) {
  const scope = usePagePath("home");
  const t = useTranslations("profile");
  const tc = useTranslations("common");
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const nav = useAccountNav();
  const qc = useQueryClient();
  const [draft, setDraft] = useState<string | undefined>(undefined);
  const [avatarError, setAvatarError] = useState<string | null>(null);
  const [storageOff, setStorageOff] = useState(false);
  const [uploading, setUploading] = useState(false);

  const save = useAppMutation({
    fn: patchProfile,
    invalidates: () => [keys.account("self").me(), ...cachedMembersKeys(qc)],
  });

  // register, upload to storage, then name the upload in the profile
  const saveUpload = useAppMutation({
    fn: async (square: Blob) =>
      patchProfile({ avatar: { kind: "upload", ...(await uploadAccountAvatar(square)) } }),
    invalidates: () => [keys.account("self").me(), ...cachedMembersKeys(qc)],
  });

  const name = draft ?? account.displayName;
  const trimmed = name.trim();
  const tooLong = lengthOf(trimmed) > NAME_MAX;
  const dirty = trimmed !== account.displayName;
  const nameError =
    trimmed === "" ? t("nameRequired") : tooLong ? t("nameTooLong", { max: NAME_MAX }) : undefined;
  const busy = save.isPending || uploading;

  async function saveName() {
    if (nameError !== undefined) return;
    try {
      await save.mutateAsync({ displayName: trimmed });
      setDraft(undefined);
      toast.success(t("saved"));
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }

  async function onUpload(file: File) {
    setAvatarError(null);
    // the picker's `accept` is a hint only: a dropped or forced file is checked here
    if (!AVATAR_UPLOAD_ACCEPT.split(",").includes(file.type)) {
      setAvatarError(t("uploadType"));
      return;
    }
    setUploading(true);
    try {
      const square = await cropAvatar(file);
      await saveUpload.mutateAsync(square);
      toast.success(t("avatarSaved"));
    } catch (e) {
      if (e instanceof ApiClientError && e.code === "storage.unavailable") setStorageOff(true);
      else setAvatarError(e instanceof ApiClientError ? errorMessage(e) : t("uploadFailed"));
    } finally {
      setUploading(false);
    }
  }

  async function onRemove() {
    setAvatarError(null);
    try {
      await save.mutateAsync({ avatar: null });
      toast.success(t("avatarRemoved"));
    } catch (e) {
      setAvatarError(errorMessage(e));
    }
  }

  const source = account.avatarSource;
  const hasAvatar = account.avatarUrl !== null;
  return (
    <SettingsPage
      header={{
        path: [...scope, { label: "account", href: ACCOUNT_HOME }, { label: "profile" }],
        title: t("title"),
      }}
      nav={nav}
      activeNav="profile"
      {...(dirty
        ? {
            actionRow: {
              unsaved: 1,
              ...(nameError === undefined ? {} : { errors: 1 }),
              cancel: { label: tc("cancel"), onSelect: () => setDraft(undefined) },
              primary: {
                label: t("save"),
                onSelect: () => void saveName(),
                loading: save.isPending && !uploading,
                disabled: nameError !== undefined || busy,
              },
            },
          }
        : {})}
    >
      <FormSection id="profile" title={t("section")} description={t("description")}>
        <Stack gap={8}>
          <Text variant="body">{t("avatarLabel")}</Text>
          <Avatar
            shape="circle"
            size={64}
            name={account.displayName}
            value={account.avatarUrl ? { kind: "image", src: account.avatarUrl } : null}
          />
          <Stack gap={8} direction="row">
            <FileButton
              label={hasAvatar ? t("replace") : t("upload")}
              accept={AVATAR_UPLOAD_ACCEPT}
              icon={<Icon name="upload" size={16} />}
              disabled={busy || storageOff}
              onFiles={([file]) => {
                if (file !== undefined) void onUpload(file);
              }}
            />
            {source?.kind === "upload" ? (
              <Button disabled={busy} onClick={() => void onRemove()}>
                {t("remove")}
              </Button>
            ) : null}
          </Stack>
          {source?.kind === "identity" ? (
            <Text variant="small" tone="muted">
              {t("fromSource", { source: source.source })}
            </Text>
          ) : null}
          {storageOff ? (
            <Text variant="small" tone="muted">
              {t("uploadOff")}
            </Text>
          ) : null}
          {avatarError !== null ? <FormError message={avatarError} /> : null}
        </Stack>
        <Field
          label={t("nameLabel")}
          required
          count={{ value: lengthOf(trimmed), max: NAME_MAX }}
          {...(nameError === undefined ? {} : { error: nameError })}
        >
          <Input name="displayName" value={name} onChange={(e) => setDraft(e.target.value)} />
        </Field>
      </FormSection>
    </SettingsPage>
  );
}
