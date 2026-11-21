---
"@capybara-hq/web": minor
---

Inside the mobile app on the iPhone Duo the web hands the native strip its sections (`nav@1`: 对话,
收件箱 with the pending count, 智能体, 定时任务), follows its taps without a slide, opens the drawer
from the strip's menu button and hides its own section entries and menu button while the strip
shows. The account sheet and menu offer 「切换平台」 through `profiles@1`, and downloads in a shell
with `openExternal@1` open in the system browser.
