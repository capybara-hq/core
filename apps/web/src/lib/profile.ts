import { apiFetch } from "./api";
import { type CreatedAttachment, uploadToStorage } from "./attachments";
import type { Account } from "./session";

/** What `POST /api/v1/me/avatar/uploads` answers (`uploadId` where an attachment has `id`). */
type CreatedAvatarUpload = Omit<CreatedAttachment, "id"> & { uploadId: string };

/** Register an avatar upload: the kernel checks type and size and returns a presigned upload. */
export const createAvatarUpload = (input: { contentType: string; size: number }) =>
  apiFetch<CreatedAvatarUpload>("/api/v1/me/avatar/uploads", {
    method: "POST",
    body: JSON.stringify(input),
  });

/**
 * Upload a cropped avatar: register, then send to object storage with the presigned upload. The
 * returned id goes into the profile as `{ kind: "upload", uploadId }`.
 */
export async function uploadAccountAvatar(file: Blob): Promise<{ uploadId: string }> {
  const name = file instanceof File ? file.name : "avatar";
  const created = await createAvatarUpload({ contentType: file.type, size: file.size });
  await uploadToStorage(
    created.upload,
    file instanceof File ? file : new File([file], name, { type: file.type }),
  );
  return { uploadId: created.uploadId };
}

/** What a client may change: the name, and the own avatar (`null` removes it). */
export type ProfileInput = {
  displayName?: string;
  avatar?: { kind: "upload"; uploadId: string } | null;
};

export const patchProfile = (input: ProfileInput) =>
  apiFetch<{ account: Account }>("/api/v1/me/profile", {
    method: "PATCH",
    body: JSON.stringify(input),
  });
