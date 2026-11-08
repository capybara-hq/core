---
"@capybara-hq/plugin-sdk": minor
---

`plugin.json` gains `setupGuides`: setup material a plugin ships for a place (`channel-connection`
first), with localized plain-text steps and template files (`yaml` / `json` / `text`, optionally
one per mode). The SDK exports the places, their modes and variables, the limits,
`setupGuidePlaceholders`, `unknownSetupGuidePlaceholders`, `setupGuideModes`,
`setupGuideFileProblem` and the pure renderer `renderSetupGuideText` (`{{name}}` placeholders, no
other syntax; values escaped per language).
