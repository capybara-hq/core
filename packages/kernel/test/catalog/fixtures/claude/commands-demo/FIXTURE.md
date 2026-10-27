# commands-demo fixture

A synthetic Claude Code plugin written for the phase D acceptance test
(`packages/kernel/test/skills/manual-invocation.e2e.test.ts`), not copied from any project:

- `commands/fix-issue.md`: a command with `argument-hint: [issue-number]` and `$ARGUMENTS`;
- `skills/manual-script/`: a manual-only skill (`disable-model-invocation: true`) with
  `scripts/run.sh`;
- `skills/review/`: a forked skill (`context: fork`, `agent: code-reviewer`);
- `agents/code-reviewer.md`: the agent the forked skill runs as.

License: MIT (see `LICENSE`).
