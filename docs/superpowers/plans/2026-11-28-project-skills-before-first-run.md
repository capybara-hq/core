# Plan: project skills before a conversation's first run

Design: [2026-11-28-project-skills-before-first-run-design.md](../specs/2026-11-28-project-skills-before-first-run-design.md).
One PR, executed inline (small, one area at a time).

1. **Kernel: last known snapshot.** `latestKnownProjectRoot` in `skills/invoke.ts` (the caller's
   own chat conversations, same device + project name + path, newest usable `project_root`).
2. **Kernel: the menu.** `InvocableSkillsQuerySchema` gains `deviceId` and `project`;
   `SkillInvoker.listFor` falls back to the last known snapshot (bound conversation without a
   `project_root`; or no conversation, with the device project named). Platform operation
   `agents.invocable-skills` takes the fields; description updated.
3. **Kernel: the send.** `prepareProject` falls back to the last known snapshot of the binding
   (the conversation's, or the new conversation's picked project passed from
   `ConversationsService.createWithMessage` → `prepareSkill`); the stub's digest wording names the
   snapshot it came from. `recordedSkillBlocked` takes the same fallback.
4. **Web.** `listInvocableSkills` / `invocableSkillsQuery` take the picked project; `ComposerBar`
   passes `project` when it has no conversation.
5. **Tests** as the design's §4; `pnpm verify --fast`, the changed kernel integration files, the
   web test; changeset on `@capybara-hq/capybara`.
6. **Spec.** §4.6 of the project root design points to this amendment.
