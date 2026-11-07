# Skills

A skill is a folder with a `SKILL.md` (the Agent Skills format) and any files it needs. The agent
sees only the skill's `name` and `description` until it loads the skill, so the description is
what decides when it is used.

```markdown
---
name: weekly-report
description: Write the weekly status report from the team's tracker. Use when asked for a weekly report or status summary.
---

# Weekly report

1. Read ...
```

## Frontmatter

- `name` (required): 1 to 64 characters, lowercase letters, digits and single hyphens. The skill
  is always known by this name; its sandbox directory is `/skills/<name>/`.
- `description` (required): 1 to 1024 characters. Say what it does and when to use it. No XML tags.
- Optional: `license`, `compatibility` (at most 500 characters), `metadata`.
- Invocation keys (Claude Code's names):
  - `disable-model-invocation: true`: only a person runs it, with `/name args`.
  - `user-invocable: false`: hide it from the `/` menu (not together with the one above).
  - `context: fork`: run it in a sub-agent.
  - `argument-hint`, `arguments`: describe the arguments a person passes.

Other keys are ignored.

## Where skills live

- In a plugin: `skills/<name>/SKILL.md`, listed or scanned (see `plugin-format`). It becomes a
  platform component, named `<plugin>:<name>`.
- In an org: created or uploaded by an org admin, or proposed by an agent and approved by a
  person. Org skills are private to the org unless shared.

## Writing tips

- Keep `SKILL.md` short and procedural; put long reference material in separate files the skill
  tells the agent to read.
- Put scripts next to the skill and tell the agent how to run them in the sandbox.
- Limits: 1000 files, 10 MB per file, 50 MB in total.
