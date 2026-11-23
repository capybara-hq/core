---
"@capybara-hq/capybara": patch
"@capybara-hq/web": patch
---

Settings → Models gives each model service the Extensions page's on / off switch, so org admins can
switch a service off there too, including one the platform turns on by default (scope `all`), which
keeps its "on by platform default" state beside the switch. Locked services (platform-wide, not
switchable, unavailable, or waiting for config while off) keep their state with no switch.
