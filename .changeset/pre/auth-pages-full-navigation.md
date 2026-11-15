---
"@capybara-hq/web": patch
---

Leaving a sign-in page for the workspace is a full navigation everywhere: 查看设备 and the way home
on the device link page, and the way home on the bind and invite pages no longer navigate inside
the client, where the workspace's import map was rendered by React (a console error) and never ran,
so a plugin's client code could not load.
