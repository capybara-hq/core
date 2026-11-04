### Task 2: Kernel avatar upload and serving

**Files:**
- Modify: `agent-profile.service.ts`, `agents.controller.ts`.
- Test: `packages/kernel/test/agents/avatar.test.ts` (with the `fake-object-store` fixture extension).

**Interfaces:**
- Consumes: Task 1's `AgentAvatar` and `updateProfile`, and `AttachmentsService.create(orgId, accountId, { name, contentType, size }, kind)` as `SkillsService.createUpload` uses it.
- Produces:
  - `POST …/agents/:agentId/avatar/uploads` with body `{ name, contentType: "image/png" | "image/jpeg" | "image/webp", size ≤ 2_097_152 }`. It answers `CreatedAttachment`, the same presigned-upload shape as skills and chat attachments, with kind `agent-avatar`.
  - A profile PATCH accepts `avatar: { kind: "upload", uploadId }`. It finalizes the upload if needed, checks that the uploader is the actor and that the content type is an image, and marks the upload used.
  - `GET …/agents/:agentId/avatar`:
    - for an `upload` avatar: a 302 to a short-lived `presignGet`;
    - for an `external` avatar: a 302 to its URL;
    - otherwise, or when the reader can't see the agent: 404.
  - With no object store, both upload routes answer 503 `storage.unavailable`. Presets still save.

- [ ] **Step 1: Write failing tests.**
  - `"upload registers an image attachment"`.
  - `"a non-image or 2 MB + 1 upload is 400"`.
  - `"saving an upload avatar consumes the upload; a second agent can't reuse it"`.
  - `"GET avatar redirects for a reader who can see the agent and is 404 otherwise"`.
  - `"without an object store the upload is 503 storage.unavailable and a preset still saves"`.
- [ ] **Step 2:** Run the test file. Expected: FAIL.
- [ ] **Step 3:** Implement, following the skills upload's comments for the finalize and consume semantics.
- [ ] **Step 4:** Run the test file and `packages/kernel/test/agents`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(kernel): agent avatar uploads and the avatar route`.

