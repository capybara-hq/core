---
"@capybara-hq/kernel": patch
"@capybara-hq/capybara": patch
---

Background Bash tasks (`run_in_background`) work on macOS devices: where `pgrep` has no `-s`, the
launch runs the command in a process group of its own, watched by a small perl launcher that
enforces the time limit and signals the group on a stop (macOS has no `setsid` or GNU `timeout`,
and its OS sandbox lets no command list or signal another command's processes).
