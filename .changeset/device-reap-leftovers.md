---
"@capybara-hq/device": patch
"@capybara-hq/plugin-sdk": patch
"@capybara-hq/capybara": patch
---

A local OS-sandboxed device now kills what a foreground command leaves running (`server &`,
`nohup …`) when the command ends, by its process group and by a per-command marker for processes
that left the group. Inside the sandbox no later command could signal them, so they leaked. A
background task launch, whose command starts with the new `BACKGROUND_LAUNCH_LINE`
(`@capybara-hq/plugin-sdk`), keeps what it starts. The `Bash` description tells the model to use
`run_in_background` for servers and watchers.
