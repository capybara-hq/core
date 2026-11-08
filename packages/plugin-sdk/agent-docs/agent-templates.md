# Authoring: agent templates

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

<!-- generated:agent-template -->
| Field | Type | Required | Meaning |
|---|---|---|---|
| `name` | string | yes | `^[a-z0-9][a-z0-9-]{0,63}$`; the type name is `<plugin>:<name>`. |
| `description` | string | yes | When to use it; at most 4096 characters. |
| `tools` | array of tool keys | no | Allowlist (at most 200); omitted = the parent's tools, `[]` = none. |
| `disallowedTools` | array of tool keys | no | Tool keys removed (at most 200). |
| `toolPolicies` | object | no | Tool key to `ask` or `deny`; can only tighten. |
| `model` | `inherit` \| `fast` \| `standard` \| `capable` | no | A purpose tier, never a model id; default `inherit`. |
| `effort` | `low` \| `medium` \| `high` \| `xhigh` \| `max` | no | Reasoning effort. |
| `maxSteps` | integer | no | Step limit; the kernel caps it. |
| `skills` | array of skill names | no | At most 3, preloaded (pinned). |
| `selectedSkills` | array of skill names | no | At most 32 further skills the agent may use. |
| `connectors` | array of objects | no | At most 16: `{ template, tools?, policies? }` for a connector template (`<id>` or `<plugin>:<id>`), or `{ needs: { protocol, endpoint, tools, label }, policies? }` for a described need. |
| `subagents` | object | no | `{ general?, types?, inline? }`: the sub-agents in its roster (at most 16 types plus inline). |
| `modelRef` | string | no | `provider/model`; set on org templates saved from an agent. |
| `quickActions` | array of objects | no | At most 9 `{ title, body }` shortcuts. |
| `instructionFiles` | array of objects | no | At most 20 `{ name, content }` files. |
<!-- /generated -->

Unknown keys are ignored. The body is at most 100,000 characters.

## Creating an agent from a template

A connector the org does not have becomes a pending entry, and a setup request goes to the org
admins. Tool keys follow `tool-naming`.
