---
"@capybara-hq/plugin-sdk": minor
---

`file-preview@1` previews skill files: `FilePreviewArgs` gains `FilePreviewSkillArgs` (`source:
"skill"`, with `orgId`, `accountId`, `skillId`, `version` and `path`; `file.id` is
`<skillId>@<version>/<path>`), and an org embed token for a skill file's previewer carries
`OrgEmbedClaims.skillFile` (`{ skillId, version, path }`, never with a conversation, agent or file
id). A previewer that matches by type needs no change.
