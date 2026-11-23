---
"@capybara-hq/device": patch
---

On Linux, a sandboxed operation whose granted roots exceed the agent's open-file limit (machine
reach carving many directories beside a denied path) is refused with that reason and how to narrow
the reach (`capybara-device ceiling set --project-reach paths`), instead of claiming a granted root
is not a directory.
