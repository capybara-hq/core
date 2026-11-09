---
"@capybara-hq/web": patch
---

The conversation composer warns before sending a draft that looks like it holds a secret (Slack,
GitHub, `sk-` model keys, AWS and Google keys, private keys, JWTs, long random strings): on paste,
and on the first ↵ or send click, a warn line with 移除 / Remove and 仍然发送 / Send anyway; a second
↵ also sends. The check runs in the browser only and is never logged or sent to the kernel.
