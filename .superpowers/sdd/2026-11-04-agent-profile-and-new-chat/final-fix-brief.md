# Final-review fix wave (agent profile & new chat)

Repo worktree: /Users/grant/Capybara/core/.claude/worktrees/fix-rc2-acceptance, branch fix/rc2-acceptance. Another device pushes to the same branch: run `git pull --rebase origin fix/rc2-acceptance` before starting and before each commit. On conflicts prefer the other device's changes outside these files.

Do exactly these four fixes, each its own commit (Conventional Commits, body lines <= 100 chars, end each message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`):

1. **Index** — new migration in packages/kernel/src/migrations, next free number after pulling (0068 unless taken), e.g. `00NN_attachments_agent_idx.sql`:
   `CREATE INDEX IF NOT EXISTS attachments_agent_idx ON capybara.attachments (agent_id) WHERE agent_id IS NOT NULL;`
   Follow .agents/skills/writing-migrations/SKILL.md (header comment style of neighbouring files). Never edit an existing migration. Add to the kernel changeset `.changeset/agent-prompt-files.md` or the profile changeset only if one line is natural; no new changeset needed for an index.
2. **Referrer** — packages/design/src/display/avatar.tsx (~line 95): the `<img>` gets `referrerPolicy="no-referrer"`. Add/adjust its test. In docs/superpowers/specs/2026-11-04-agent-profile-and-new-chat-design.md §2.3, where it says the avatar route proxies external images, record the decision: the route answers 302 to an https URL (presigned or external), never proxies; images load with no referrer.
3. **Changeset** — `.changeset/agent-prompt-files.md`: add one sentence: `PATCH /agents/:id` with a definition but no `instructions` (and no `instructionFiles`) now keeps the current prompt instead of clearing it.
4. **Design reference coverage** — docs/design/spec.md and apps/web/visual/accepted.ts and the /dev/ui reference blocks (apps/web/src/app/dev/ui/reference/...): add the missing state/size-table rows and reference blocks for
   - Avatar initials at size 24 (size-table row),
   - PageHeader's avatar slot,
   - the avatar in the conversation title bar (16), sidebar group rows (16), and object/agent list rows (28).
   Follow .agents/skills/writing-web-ui/SKILL.md and how earlier avatar entries (§6.30) and their /dev/ui blocks are written. Existing fidelity tests must still list consistent sizes; do not run Playwright or Next build (a dev server runs from this worktree). Do NOT add reference-HTML-render outputs (PNGs) — the user runs visual-update / reference-update workflows.

Verify: `pnpm lint`, `pnpm typecheck`, `pnpm check`, and `pnpm exec vitest run packages/design tools/checks apps/web/test` plus the kernel migration test(s) touching migrations if quick (`pnpm exec vitest run packages/kernel/test/migrations*` if present). Report failures faithfully.

Then `git push origin fix/rc2-acceptance` (pull --rebase first). Do not dispatch subagents.

Write the full report to .superpowers/sdd/2026-11-04-agent-profile-and-new-chat/final-fix-report.md; return only status, commits, one-line test summary, concerns.
