### Task 1: Kernel profile storage and API

**Files:**
- Create:
  - `packages/kernel/src/migrations/0066_agent_profiles.sql`
  - `packages/kernel/src/agents/profile.ts`
  - `packages/kernel/src/agents/agent-profile.service.ts`
- Modify:
  - `packages/kernel/src/agents/agents.controller.ts`
  - `packages/kernel/src/agents/agents.service.ts` (create: profile and random preset)
  - `packages/kernel/src/agents/agents.module.ts`
  - the error codes registry
- Test: `packages/kernel/test/agents/profile.test.ts`

**Interfaces:**
- Produces:
  - `type AgentAvatar = { kind: "preset"; id: PresetId } | { kind: "upload"; uploadId: string } | { kind: "external"; url: string } | null`. The `external` kind exists only for migrated `definition.avatarUrl` values.
  - `interface AgentProfile { avatar: AgentAvatar; description: string; quickActions: { title: string; body: string }[]; updatedAt: string }`
  - The agent view (`GET …/agents`, `GET …/agents/:agentId`, and create's answer) gains `profile: AgentProfile`.
  - `PATCH /api/v1/orgs/:orgId/agents/:agentId/profile` with body `{ avatar?, description?, quickActions?, expectedUpdatedAt: string }`. It answers `{ profile }`, or 409 `agent.profile_conflict`.
  - `POST …/agents` accepts optional `profile`. Without an avatar, the agent gets `randomPreset()`.
  - `PRESET_IDS: readonly PresetId[]` and `randomPreset(): PresetId`.
- Permission: the same check as `PATCH :agentId` today.
- Audit action: `agent.profile_updated`, with `{ fields: string[], channel: "web" | "api" }`. The channel is `api` for service tokens and `web` for sessions.

- [ ] **Step 1: Write failing tests.**
  - `"create without a profile gets a random preset avatar"`: the answer's `profile.avatar.kind === "preset"` and its `id` is in `PRESET_IDS`.
  - `"profile changes create no agent version"`: after a PATCH, `currentVersion` is unchanged.
  - `"profile limits"`: these get 400 `validation_failed`:
    - a `description` of 501 characters;
    - 10 quick actions;
    - a title of 41 characters;
    - a body of 20 001 characters;
    - an unknown preset id.
  - `"a stale expectedUpdatedAt is 409 agent.profile_conflict"`.
  - `"a profile change writes agent.profile_updated with the fields"`.
  - `"an existing definition.avatarUrl migrates once to an external avatar"`: run the migration on a seeded row, then check `profile.avatar` equals `{ kind: "external", url }`.
  - `"old agents read profile.avatar null, description '' and quickActions []"`.
- [ ] **Step 2:** Run `pnpm exec vitest run packages/kernel/test/agents/profile.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - **Migration**: on `capybara.agents`, add the nullable columns `profile_avatar jsonb`, `profile_description text NOT NULL DEFAULT ''`, `profile_quick_actions jsonb NOT NULL DEFAULT '[]'` and `profile_updated_at timestamptz NOT NULL DEFAULT now()`. Then backfill `profile_avatar` from the current version's `definition->>'avatarUrl'` where that is not null, as an `external` avatar.
  - Register `agent.profile_conflict` in the error codes.
  - The web stops writing `avatarUrl`; Task 5 does that. The schema keeps it.
- [ ] **Step 4:** Run the test (expected: PASS), then `pnpm exec vitest run packages/kernel/test/agents` (expected: no regressions), then `pnpm check:kernel-conventions`.
- [ ] **Step 5:** Commit `feat(kernel): agent profiles (avatar, description, quick actions) outside the versions`.

