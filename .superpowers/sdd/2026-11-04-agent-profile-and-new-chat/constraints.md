## Global Constraints

- Work on `fix/rc2-acceptance`, in `.claude/worktrees/fix-rc2-acceptance`. Another machine also pushes to it, so run `git pull --rebase origin fix/rc2-acceptance` before every commit.
- Repo rules come from `AGENTS.md`:
  - kernel conventions: `@Inject`, `@Transactional`, `createZodDto` plus `@ZBody`/`@ZParam`, `afterCommit`, and no enqueue inside a transaction;
  - migrations are `NNNN_<snake>.sql`, expand-only, `IF NOT EXISTS`;
  - `apps/web` writes no styles;
  - UI text is i18n in zh and en;
  - code comments and test titles are in English.
- Profile limits:
  - `description` is at most 500 characters and may be empty;
  - `quickActions` holds at most 9 entries;
  - a quick action's `title` is 1–40 characters and its `body` is 1–20 000 characters.
- Presets: exactly 10, with ids `capybara`, `black-bear`, `panda`, `elephant`, `fox`, `owl`, `penguin`, `rabbit`, `turtle`, `whale`.
- Upload: png, jpg or webp, at most 2 MB, cropped square in the browser.
- Prompt files: names unique and ending in `.md`; the default and first file is `AGENTS.md`; at most 20 files; a total of at most 100 000 characters; at least one file.
- The profile is never model-visible, and a profile change creates no agent version.
- The definition keeps `instructions` as the model-visible field, derived from `instructionFiles` on save. Old versions read as one `AGENTS.md`.
- New conversation page:
  - the agents row shows at most 5 agents, then "更多 +N";
  - it is hidden when there is one usable agent;
  - quick actions show the first 4 titles, then "更多".
- Greeting copy (zh) is the spec §4.1 table, verbatim; en matches it in tone.
- Visual baselines and reference PNGs come only from the `visual-update` / `reference-update` workflows. Do not trigger them; the user decides.
- Commits use Conventional Commits, with body lines ≤ 100 characters, each ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. An existing agent with no avatar (`avatar: null`) shows its initial in every place an `Avatar` is used. Pinned in Task 4 (component) and Task 10 (adoption).
2. With no object store configured, upload explains why it is off and presets still save. Pinned in Task 2 (503 `storage.unavailable`) and Task 6 (UI).
3. Two tabs edit quick actions. The second save gets 409 and offers a reload, never a silent overwrite. Pinned in Task 1 and Task 6.
4. Clicking a quick action while the composer has text replaces it, and ⌘/Ctrl+Z restores the previous text. Pinned in Task 9.
5. The greeting at hour boundaries: 23:00–04:59 wraps midnight, and 05:00, 11:00, 13:00 and 18:00 each open a new bucket. Pinned in Task 8 (`greetingBucket` unit test).

---

## Controller rulings (binding)
- Ruling: T1 adds the `upload` kind to the type and schema, but a PATCH with an upload avatar is 400 until T2 wires it — keeps T1 testable alone — cost: none
- Ruling: migration numbers are the next free number after `git pull --rebase` at commit time, not a fixed 0066 — the other machine may land a migration first — cost: none
- Ruling: before each task and each commit, pull --rebase; on conflicts with the tool-rename work prefer its tool names and definition changes and re-run the covering tests — two machines on one branch — cost: a rebase per task
- Avatar sizes are 16, 24, 28, 40, 64 (the plan's 22 became 24 by ruling).
- useUpdateProfile is exported from apps/web/src/lib/query/mutation.ts (ruling).
