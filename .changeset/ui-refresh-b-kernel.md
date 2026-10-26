---
"@capybara-hq/kernel": minor
---

Tool presentation for the conversation page: `GET /conversations/:id/tools?keys=…` returns each tool's title, kind (command, read, edit, search, connector, meta, tool), key arguments and source. `title` and `keyArgs` are left out of the tool definition fingerprint, so they never trigger drift review; a connector refresh that changes only them updates the stored definition silently. Builtin tools declare their key arguments.

`sandbox_bash` takes a required `description` (a few words saying what the command is for; the shell row shows it). Builtin tool results carry a display-only `tool_result.view`: the exit code and description of a command (a non-zero exit shows as failed while `isError` is unchanged), a capped line diff for `sandbox_edit` / `sandbox_write`, and the line range of `sandbox_read`. Full-run replay and the structural diff ignore `description` when matching `sandbox_bash` calls, so recordings made before it still match.

Approvals: a denial may carry a `reason` (1–500 characters); it is stored, shown as `denyReason`, written to `approval_decided` and passed to the model in the denied call's result ("The user denied this tool call. Reason: …"). `approval_requested` names the policy that asked (`agent`, `connector`, `default` or `role`). Migration `0054_approval_reason` adds `approvals.deny_reason`.
