---
"@capybara-hq/capybara": patch
---

Live tool rows open by themselves: a streaming `Write` / `Edit` diff, an `Agent` prompt, a generic
tool's input and a running call whose output grows show their detail without a click and follow
its tail; when the call ends, a row the person never toggled folds back, a toggled row keeps the
person's choice. Every tool detail box (finished and live diffs, outputs, the IN command and
inputs, the trajectory view's IN / OUT blocks) is one compact viewport of about twelve lines that
scrolls, with an expand control (展开 / 收起) to a tall cap when its content overflows.
