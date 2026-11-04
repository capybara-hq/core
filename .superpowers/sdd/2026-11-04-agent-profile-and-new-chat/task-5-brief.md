### Task 5: Web query layer for profiles

**Files:**
- Modify:
  - `apps/web/src/lib/agents.ts` (types, `updateAgentProfile`, `createAvatarUpload`)
  - `apps/web/src/lib/query/agents.ts` (`profile` on the agent queries, `useUpdateProfile`)
  - the agent create and update callers (stop sending `avatarUrl`)
- Test: `apps/web/test/agent-profile-lib.test.ts`.

**Interfaces:**
- Consumes: Tasks 1–2's routes.
- Produces:
  - `Agent.profile: AgentProfile`, with the same shape as the kernel's.
  - `avatarValue(agent, orgId): AvatarValue`. It maps `upload`/`external` to `{ kind: "image", src: "/api/v1/orgs/<org>/agents/<id>/avatar?v=<updatedAt>" }`.
  - `useUpdateProfile(orgId, agentId)`: a mutation that sends `expectedUpdatedAt`. It sets the agent queries from the answer; on a 409 it surfaces `agent.profile_conflict`.
  - `uploadAvatar(orgId, agentId, file: Blob): Promise<{ uploadId: string }>`, which uses the existing attachment upload helper.
  - i18n for `agent.profile_conflict`, `agent.instructions_mismatch` and `storage.unavailable`.
- [ ] **Step 1:** Write failing tests: `"avatarValue maps presets, uploads and null"`, `"a 409 surfaces agent.profile_conflict"`, `"a profile update sets the cached agent without a refetch"`.
- [ ] **Step 2:** Run them. Expected: FAIL. **Step 3:** Implement. **Step 4:** Run them. Expected: PASS. Then run `pnpm check:web-ui`.
- [ ] **Step 5:** Commit `feat(web): agent profile reads, saves and avatar uploads`.

