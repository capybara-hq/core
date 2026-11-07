# Agent templates

An agent template describes a whole agent: instructions, tools, skills, connectors and the
sub-agents it may dispatch. A member creates a private agent from a template; org admins can also
save an agent as an org template. A plugin ships templates as `agents/<name>.md`: Markdown with
YAML frontmatter, the body being the instructions.

```markdown
---
name: researcher
description: Finds and summarizes sources on a topic. Use for open-ended research.
model: standard
tools: [WebSearch, WebFetch, Read]
skills: [citation-style]
---

You are a careful researcher. ...
```

## Frontmatter

| Field | Meaning |
|---|---|
| `name` | Required. `^[a-z0-9][a-z0-9-]{0,63}$`. The type name is `<plugin>:<name>`. |
| `description` | Required. When to use it; at most 4096 characters. |
| `tools` | Allowlist of tool keys (at most 200). Omitted = the parent's tools; `[]` = none. |
| `disallowedTools` | Tool keys removed. |
| `toolPolicies` | Tool key to `ask` or `deny`; can only tighten. |
| `model` | `inherit` (default), `fast`, `standard` or `capable`: a purpose tier, never a model id. |
| `effort` | `low`, `medium`, `high`, `xhigh` or `max`. |
| `maxSteps` | Step limit; the kernel caps it. |
| `skills` | Up to 3 skill names preloaded (pinned). |
| `selectedSkills` | Up to 32 further skill names the agent may use. |
| `connectors` | Up to 16 entries: `{ template, tools?, policies? }` for a connector template (`<id>` or `<plugin>:<id>`), or `{ needs: { protocol, endpoint, tools, label }, policies? }` for a described need. |
| `subagents` | `{ general?, types?, inline? }`: the sub-agents in its roster (at most 16 types plus inline). |
| `modelRef` | `provider/model`; set on org templates saved from an agent. |
| `quickActions` | Up to 9 `{ title, body }` shortcuts. |
| `instructionFiles` | Up to 20 `{ name, content }` files. |

Unknown keys are ignored. The body is at most 100,000 characters.

## Creating an agent from a template

A connector the org does not have becomes a pending entry, and a setup request goes to the org
admins. Tool keys follow `tool-naming`.
