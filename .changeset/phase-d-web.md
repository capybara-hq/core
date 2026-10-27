---
"@capybara-hq/web": patch
---

The import review names the phase D translation codes (`command_imported`, `skill_manual_only`,
`skill_forked`, `command_invalid`, `skill_shell_injection`, `skill_agent_unknown`,
`skill_invocation_key_ignored`, `skill_file_reference`); the codes no
longer emitted read as "not supported when this version was imported".

Copy for the new error code `skill.not_invocable`.

Skills in the conversation (phase D): `/` in an empty composer lists the agent's skills first
(sorted, with the argument hint, the "manual" / "sub-agent" tags and the plugin's name, searchable
by `<plugin>:<name>`), then the connector prompts. Picking one shows the skill chip; the text after it
is the arguments (Backspace at the start or the chip's x removes it). A draft typed as
`/name args` that names one of the agent's skills is sent as its invocation, anything else as
text; ⌘↵ queues an invocation, and the queued bubble shows its chip. The bubble of an invocation
shows the chip, the arguments and a "Skill instructions" disclosure with what was sent; a forked
skill shows its sub-agent row and a "Report" disclosure; a plain message that waits for a forked
skill's sub-agent says so. Retry repeats a failed invocation. A queue paused because its first
message's author can no longer send, or its skill can no longer be used, says why. The agent page
tags manual and sub-agent skills, does not let a manual skill be pinned, warns about a pinned
skill that became manual, and names the `manual_only` refusal.

Text typed while a message is still being sent is kept when the send returns (only what was sent
is cleared). Below 1280 px the conversation page no longer draws its right panel beside the thread
for a moment before it becomes a sheet (the page could scroll sideways until the page was ready).

The ⌘K palette filters like the `/` menu: by prefix, then substring, of the label (and its hidden
search text), then of the description; scattered letters ("nwcv") no longer match.
