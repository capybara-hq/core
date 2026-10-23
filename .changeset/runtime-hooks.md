---
"@capybara-hq/kernel": minor
---

Model and tool hooks in the runtime (chat conversations only; eval replays never fire them):
`model.request` runs before `model_call` is written and a policy denial fails the run with
`run.hook_denied` without calling the provider; `model.response` observes every sent attempt (usage on
success, `errorCode` on failure); `tool.preExecute` runs after policy and approval, and a denial ends
the call with `Tool call blocked by the "<plugin>" policy hook: <reason>` without executing it;
`tool.postExecute` observes the result. Every denial is logged as a `hook_denied` event (not
model-visible) plus a `hook.denied` audit entry, and the trajectory shows it.
