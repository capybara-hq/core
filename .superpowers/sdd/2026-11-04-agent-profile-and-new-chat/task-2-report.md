# Task 2 report: kernel avatar upload and serving

Status: DONE. Commit 94e99606 (pushed to fix/rc2-acceptance).

## Built
- Migration 0067_agent_avatar_uploads.sql: attachments purpose check gains 'agent-avatar'; new nullable column attachments.agent_id (the agent whose profile uses the upload).
- AttachmentsService: purpose agent-avatar in create (png/jpeg/webp, <= 2 MiB, 10 pending, 24 h TTL, key agent-avatars/<id>); prepareAgentAvatar (outside tx: uploader, purpose, type, expiry, not used by another agent; finalizes a pending upload, sniffing the image signature); consumeAgentAvatar (mandatory tx, row lock, binds agent_id, clears expires_at so the cleanup job keeps it); agentAvatarUrl (presignGet 300 s, inline, checked content type, etag check).
- AgentProfileService.update: now a wrapper that prepares an upload avatar, then runs the @Transactional updateIn which consumes it after the conflict check. assertProfileWritable still rejects upload on agent create (no agent id yet); no longer called on PATCH.
- Controller: POST :agentId/avatar/uploads (agents.create; body Zod: name, contentType enum, size 1..2_097_152 -> 400), GET :agentId/avatar (agents.use; 302 for upload or https external, 404 agent.not_found otherwise or if invisible; cache-control private max-age 60).
- AgentsModule imports AttachmentsModule.

## TDD
RED: `pnpm exec vitest run packages/kernel/test/agents/avatar.test.ts` -> 6 failed (routes 404).
GREEN: same command -> 6 passed. `packages/kernel/test/agents` + `test/skills` -> all pass (110 in agents). pnpm check, pnpm typecheck pass; biome check packages/kernel: no errors (9 pre-existing warnings).

## Tests (avatar.test.ts)
- upload registers an image attachment
- a non-image or 2 MB + 1 upload is 400
- saving an upload avatar consumes the upload; a second agent can't reuse it (also: other account 404, cleanup keeps used avatar)
- an upload whose bytes are not the declared image is refused (415)
- GET avatar redirects for a reader who can see the agent and is 404 otherwise (upload, private agent, external https/http, preset, null)
- without an object store the upload is 503 storage.unavailable and a preset still saves (second kernel without store)

Also edited profile.test.ts: removed the "upload avatar is 400" case (that kernel has no store, now 503; covered in avatar.test.ts).

## Self-review / concerns
- Replacing an avatar leaves the old upload row and object in place (agent_id set, no expiry); no GC. Could add later.
- Upload registration checks only that the agent is visible; write permission is enforced on save.
- Create with an upload avatar is still 400 (upload after creating).
- GET with no store and an upload avatar answers 503 (assertAvailable).
- Migration alters a check constraint (precedent 0053), no destructive exemption needed.

## Fix round 1
- Profile PATCH that sets `avatar` now expires (expires_at = now()) every other agent-avatar upload bound to the agent, in the same transaction; re-saving the same upload is excluded. Soft delete expires the agent's avatar uploads in its transaction. The existing cleanup job then deletes row and object.
- GET avatar: malformed external URL -> 404 (try/catch around new URL).
- Tests added: "create with an upload avatar is 400"; "a replaced avatar's upload expires" > "replacing it with a preset, another upload or null expires the old row", "re-saving the same upload keeps it", "deleting the agent expires it and the cleanup job deletes the object"; external `https://` case added to the GET test.
- `pnpm exec vitest run packages/kernel/test/agents`: 9 files, 114 passed. pnpm check, typecheck, biome clean.
