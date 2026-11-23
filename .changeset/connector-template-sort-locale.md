---
"@capybara-hq/web": patch
---

The connectors page sorts template cards with the page's locale, so the server render and the
browser agree (they differed for Chinese names such as Google 表格 / Google 云端硬盘 and failed
hydration).
