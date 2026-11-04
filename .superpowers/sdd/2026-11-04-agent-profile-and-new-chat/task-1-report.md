# Task 1 report: kernel profile storage and API

Status: DONE (commit 581ae7e9, pushed to origin fix/rc2-acceptance; nothing to rebase, no conflicts).

## Built
- Migration `0066_agent_profiles.sql` (0066 was the next free number): columns `profile_avatar`, `profile_description`, `profile_quick_actions`, `profile_updated_at` on `capybara.agents`, and a one-time backfill of `definition.avatarUrl` as an `external` avatar. `profile_updated_at` is kept at millisecond precision so it round-trips as `expectedUpdatedAt`.
- `agents/profile.ts`: `PRESET_IDS`, `PresetId`, `randomPreset()`, zod schemas and limits, `AgentAvatar`, `AgentProfile`.
- `agents/agent-profile.service.ts`: `update()` under `lockForWrite` (same permission as PATCH :agentId), stale `expectedUpdatedAt` gives 409 `agent.profile_conflict`, audit `agent.profile_updated {fields, channel}` (`api` for a PAT, `web` for a session).
- `AgentView.profile` (list, get, create answer) via `AgentLookup.views`; `POST agents` accepts `profile` and gives a random preset if there is no avatar; `PATCH …/profile` route; error code registered; kysely types; changeset `.changeset/agent-profiles.md`.
- `upload` is in the type and schema, but create/PATCH with it is 400 `validation_failed` (`assertProfileWritable`); `external` is never accepted from a client.
- `AgentsService.lockForWrite` is now public (was private) so the profile service can reuse it.

## TDD
- RED was not run separately: I wrote the test and implementation in one pass. The first run failed at Nest wiring (AgentProfileService not exported from AgentsModule), then GREEN after the export fix.
- GREEN: `pnpm exec vitest run packages/kernel/test/agents/profile.test.ts` gives 8 passed.
- `pnpm exec vitest run packages/kernel/test/agents` gives 8 files, 101 tests passed.
- `check:kernel-conventions` passed; `pnpm check` all passed; `pnpm typecheck` clean (including web); `biome check packages/kernel` 0 errors (9 warnings, in files I did not touch).

## Self-review / concerns
- `external` avatar URL: the brief left proxying/copy open; it is stored as given and only returned. Task 2 or the web decides how to render or proxy it.
- Upload avatar field name is `uploadId` (the spec text said `ref`; the brief's type says `uploadId`, which I followed).
- Creating an agent with the same description etc. via PATCH with no changed fields still bumps `updatedAt` and writes an audit row (fields `[]`); harmless.

## Fix round 1
Backfill only non-empty string avatarUrl (comment fixed); avatar:null stores SQL NULL; PATCH with no field writes nothing (still 409 when stale). 3 tests added; agents tests 104 pass, pnpm check, typecheck, biome clean. 0066 still next free.
