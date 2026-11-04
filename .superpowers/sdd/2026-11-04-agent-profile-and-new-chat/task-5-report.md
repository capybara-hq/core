# Task 5 report: web query layer for profiles

## Built
- `lib/agents.ts`: `AgentAvatar`, `QuickAction`, `AgentProfile`, `ProfileInput`, `Agent.profile`, `avatarValue(agent, orgId)`
  (upload/external -> `/api/v1/orgs/<org>/agents/<id>/avatar?v=<encoded updatedAt>`), `updateAgentProfile`,
  `createAvatarUpload`, `uploadAvatar(orgId, agentId, file: Blob)` (register, then `uploadToStorage`; returns `{ uploadId }`).
- `lib/query/mutation.ts`: `useUpdateProfile(orgId, agentId)` (client-only hook, so it lives here per `web-lib-client-hook`).
  Sends cached `profile.updatedAt` as `expectedUpdatedAt` (a variable may override); on success sets the agent and
  agents-list caches from the answer, no invalidation or refetch; 409 `agent.profile_conflict` is the mutation error.
- `AgentForm.tsx` strips the retired `avatarUrl` from the spread existing definition (next to `instructionFiles`).
- i18n zh+en: `errors.agent.profile_conflict`, `errors.agent.instructions_mismatch`. `errors.storage.unavailable` already existed.

## TDD
RED (impl reverted): `pnpm exec vitest run apps/web/test/agent-profile-lib.test.ts` -> 3 failed
("avatarValue is not a function", "useUpdateProfile is not a function"). GREEN after restoring: 3 passed.
Full: `vitest run apps/web/test` 81 files / 1671 tests pass; `check:web-ui`, `check:i18n`, web typecheck, biome all pass.

## Tests
- avatarValue maps presets, uploads and null
- a 409 surfaces agent.profile_conflict
- a profile update sets the cached agent without a refetch

## Files
apps/web/src/lib/agents.ts, apps/web/src/lib/query/mutation.ts, apps/web/src/components/AgentForm.tsx,
apps/web/messages/{en,zh}.json, apps/web/test/agent-profile-lib.test.ts

## Concerns
- Brief placed `useUpdateProfile` in `lib/query/agents.ts`; moved to `mutation.ts` because check:web-ui forbids hooks there.
- `uploadAvatar` has no browser-side test (XHR); it reuses the tested `uploadToStorage`.
- `Agent.profile` is required; test fixtures cast so typecheck is unaffected.

## Fix round 1
- `useAppMutation` takes a pass-through `scope`; `useUpdateProfile` uses `agent-profile-<org>-<agent>`, so saves of one
  agent run in turn and `fn` reads the cached `updatedAt` after the previous `onSuccess`.
- `errors.agent.profile_unloaded` added (zh, en).
- New tests: "two quick saves both succeed and the second sends the first's new updatedAt" (fails without scope),
  "a sequential second save sends the new updatedAt", "uploadAvatar registers the Blob's type and size" (503 surfaces
  `storage.unavailable`).
- Output: apps/web/test 81 files / 1674 tests pass; check:web-ui, check:i18n, typecheck, biome clean.
