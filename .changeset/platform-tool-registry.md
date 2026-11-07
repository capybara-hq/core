---
"@capybara-hq/kernel": patch
"@capybara-hq/web": patch
---

The kernel gains the `Platform` tool's operation registry and its availability rules (who may call
an operation now, and why not), and orgs gain the `platformTool` setting (`on` / `read-only` /
`off`, default on) with a select on the organization settings page.
