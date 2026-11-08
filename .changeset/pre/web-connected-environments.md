---
"@capybara-hq/web": patch
---

Connected environments in the web app: the `/device` page confirms a `capybara-device login`
(the code, the machine, the org, a new or existing environment and the disclosure); 新建环境
offers 云端沙箱 or 接入设备 (the install and login commands, then waits for the machine); the
environment page shows the machine with 断开这台机器; the picker lists connected environments
with 在线 / 离线 and an offline one cannot be chosen.
