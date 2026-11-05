# Tool naming (Claude Code alignment) live acceptance checklist

Spec: `docs/superpowers/specs/2026-10-29-tool-naming-claude-code-design.md` §14 and "As built".

The automatic half (zero-drift fixtures for pre- and post-rename recordings, read-before-write on two
replicas, migration 0063, the checks) runs in `pnpm test` / `pnpm check`. This checklist is the manual
half, run from the branch worktree before the release that ships the rename.

## 0. Credentials

Credentials live in `~/.capybara-test.env` (outside the repository) and are injected into the
environment of one command only. **Never print, `cat` or paste the values**; never commit them.

```bash
( set -a; . ~/.capybara-test.env; set +a; <command> )   # only injects the environment
```

| Variable | Used by |
|---|---|
| `CAPYBARA_TEST_*` of the bundled providers | step 7, in `capybara-hq/plugins` |

## Steps

| # | Step | Expected | Result |
|---|---|---|---|
| 1 | Upgrade a release-candidate database dump (conversations, grants, agent versions using `toolPolicies`, an inline sub-agent template, an eval set) with `capybara migrate` and start the kernel | Migration 0063 applies; at most one `tools.legacy_key_unmapped` WARN; agents run | |
| 2 | Check grants after the upgrade | **Builtin grants will not match** (the spec hash changed), so people are asked again once: expected. Connector and extension grants (`mcp__…` / `plugin__…`) still apply without a prompt | |
| 3 | Start a call that waits for approval on the old build, upgrade, then approve | The call completes; the approval card shows `<display name> [<tool>]` | |
| 3a | As step 3 with a `sandbox_edit` / `sandbox_write` call on an existing file | Approved once, not asked again; it then fails with "File has not been read yet" (rc reads recorded no digest): expected, the model reads the file again and retries | |
| 4 | Continue an old conversation (history holding old tool names) | The run continues; the model uses the new names; no error from the provider | |
| 5 | Full-run replay of an eval case recorded before the rename | Matches the recordings, no `tool_unmatched`; the result reports `legacyKeyMatch` | |
| 6 | A Claude Code plugin whose skill names Bash / Read / Edit / Skill / TodoWrite, on an agent with a sandbox and the todo plugin | The skill runs with the shorter tool map; TodoWrite becomes `plugin__todo__write` | |
| 7 | Each bundled provider dialect with a history holding old tool names: the live tests of `capybara-hq/plugins`, run with `CAPYBARA_TEST_*` | No provider rejects history tool names absent from the tool list (spec §15; fallback only if one does) | Pass (2026-11-05): anthropic, openai, openai-compatible `deepseek`; the other openai-compatible dialects not run |
| 8 | Read-before-write: `Edit` without `Read`, `Edit` after a `Bash` change, `Write` to a new path | "not read yet" / "modified since" / succeeds | |
| 9 | After pushing, run the `visual-update` workflow, then push an empty commit to rerun CI | Baselines regenerated; the conversation, approval card, inbox and an IM card show the §7 labels | |

## Results

| Step | Date | Result | Notes |
|---|---|---|---|
| 1-6, 8, 9 | | | |
| 7 | 2026-11-05 | Pass | `live history with renamed tools` in capybara-hq/plugins#10: a history calling `sandbox_bash` with only `Bash` in the tool list. Accepted by anthropic `claude-haiku-5-5`, openai `gpt-5-nano`, openai-compatible deepseek `deepseek-flash`; the `generic`, `qwen` and `ark` dialects were not run. No fallback needed |
