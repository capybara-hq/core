---
"@capybara-hq/plugin-sdk": patch
---

Document the narrowing rule of `DeviceProvider.update`: `"updated"` for a narrowing only once no
connection to a removed host survives and no new one can open (otherwise `"recreate"` or throw), and
never a state a later rebuild of the instance could widen.
