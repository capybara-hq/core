---
"@capybara-hq/web": patch
"@capybara-hq/capybara": patch
---

Client component pages (`org.page`, `platform.page`) and agent sections (`agent.detail.section`)
always draw their body with designed states: loading while the module loads, the failure line
(retry reloads the page) after a failed load, and "not available" when the code is off (safe mode,
the kill switch, a spent crash budget, a withdrawn plugin). Their nav entries (the sidebar's
extension pages, the agent page's sections, the admin console's platform pages) are not offered
while the code is off.
