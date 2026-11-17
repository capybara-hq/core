---
"@capybara-hq/kernel": patch
---

Full permission replaces the auto-mode switch in the public platform and org configuration:
`devices.fullAccess` (`CAPYBARA_DEVICES__FULL_ACCESS`), the deployment setting `devicesFullAccess`
(`{ permission }`) and the org setting `fullAccess`. The old keys (`devices.autoMode`,
`devicesAutoMode: { mode }`, org `autoMode`) are still accepted with the same values and keep
their source's precedence; an old and a new key that differ are refused. The permission
configuration publication moves to projection version 2: the first start converts a released
version 1 publication and the stored settings keys in one transaction (format only, nothing is
reset or cancelled), and a semantic difference still needs `--activate-permission-config`. Until
the old inputs are removed, readers take the narrower of the old and new stored keys and org
writes carry the old key along, so nothing stored as off reads as allowed. Old replicas fail the
operation barrier after the conversion, but their settings writes are not fenced: stop every old
replica before the first new replica starts.
