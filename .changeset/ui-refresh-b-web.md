---
"@capybara-hq/web": minor
---

The org extensions settings page lists the file previewers (`file-preview@1`) of enabled extensions, in the order the org tries them, with up / down and an enable switch. Embed previewers receive the file over the message bridge after `init`.

The conversation page is rebuilt on the `ConversationPage` template: a title bar with the generated title and rename, tool calls grouped after Claude Code (titles, key arguments, shell descriptions, diffs, failures from exit codes, "View all" for archived output), thinking rows, run dividers (stopped, failed with Retry, compacted with the saved tokens, model fallback, extension policy), the approval, question and connect blocks, file outputs, and a composer that holds the agent, model and effort pickers. ↵ sends (interjects while a run is going), ⌘↵ / Ctrl+↵ queues; queued messages show under the thread with copy, edit, delete, "Send now" and "Continue sending" after a pause. "New conversation", the Agents list and a sidebar group's ＋ open `/chat` (`?agent=`), and the conversation is created on the first send. The sidebar reloads when a title changes. `PlaygroundPage` is removed.
