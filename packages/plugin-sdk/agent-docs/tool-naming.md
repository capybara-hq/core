# Tool naming

The model-visible tool key grammar:

| Kind | Key | Example |
|---|---|---|
| Builtin | PascalCase, 2 to 32 letters | `Bash`, `Read`, `Skill`, `Platform` |
| Connector | `mcp__<slug>__<tool>` | `mcp__crm__search_accounts` |
| Extension | `plugin__<plugin>__<tool>` | `plugin__todo__write` |

Use these keys in `tools`, `disallowedTools` and `toolPolicies` of an agent template, and in
policies. Keys never contain dots.

## Writing a tool

- Describe it in English, in one or two sentences saying what it does and when to use it.
- Make errors actionable: say what was wrong and what to do next, not just "failed".
- An extension registers tools with `ctx.tools.register` and declares the permission in its
  manifest; the kernel adds the `plugin__<plugin>__` prefix.
- Connector tools get their `mcp__<slug>__` prefix from the connector's slug.
- Tool policies are `allow`, `ask` or `deny`; a template or agent may only tighten them.
