---
"@capybara-hq/kernel": patch
"@capybara-hq/capybara": patch
---

Load installed plugins packed before core#720 again: the reviewed static manifest stored with
their install record still lists `config.org`, which the module's manifest no longer has, so every
such plugin was refused with `manifest_mismatch`. The legacy list is dropped before the comparison.
With the SDK's temporary `orgAccess` no-op and `defineExtension` dropping `config.org` (same
release), modules such as deepseek, jina, ark, bailian, lark and slack import and load again; their
org-only fields reach no permission set or view. Removed in core#720 plan Task 17.
