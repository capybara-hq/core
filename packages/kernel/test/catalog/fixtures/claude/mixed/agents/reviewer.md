---
name: reviewer
description: Reviews code
tools: Read, Grep, Bash, Agent, AskUserQuestion, WebFetch
model: haiku
maxTurns: 12
skills:
  - plain
permissionMode: acceptEdits
hooks:
  Stop:
    - hooks:
        - type: command
          command: echo done
mcpServers:
  - docs
memory: project
isolation: worktree
---

You review code.
