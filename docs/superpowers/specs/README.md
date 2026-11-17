Specs written before M7 are in Chinese unless noted; the architecture and extension-model specs have been translated.

## Writing a spec

A spec dated 2026-11-17 or later (the date in the file name) carries a section
`## AGENTS.md rules touched`: the rules of AGENTS.md ("Rules by area", multi-replica discipline,
dependency direction) the design touches and how it satisfies each, or `none` with a reason.
`pnpm check:agent-docs` refuses a spec without it. Earlier specs are exempt.
