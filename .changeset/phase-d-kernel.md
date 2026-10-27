---
"@capybara-hq/kernel": patch
---

Manual skill invocation (package ecosystem phase D):

- A skill version stores its invocation metadata (`skill_versions.manifest.invocation`, only when
  not the default) at upload, catalog install and upgrade, and `skill_write`; versions written
  before phase D keep the defaults (no backfill).
- Manual-only versions (`disable-model-invocation: true`) stay out of the model's skills catalog,
  its change reminders and the pinned skills; pinning one is 400 `agent.pinned_invalid`
  `manual_only`, and a pinned skill whose new version is manual-only is dropped at run start with
  a warning. A skill neither the model nor a person could use is `skill.invalid_package`.
