---
"@capybara-hq/kernel": minor
---

A sub-agent's approval, question or connect card, at any depth, is shown in the root conversation
of its tree: `subagent_waiting` is appended to the root's log (no longer to the direct parent's)
and gains `path`, the child conversation ids from the root's child down to the waiting agent. The
approval still goes to the trigger account inherited down the chain. "Approve for this
conversation" grants of sub-agents are stored on and read from the root conversation, so every
agent of the tree uses them, and the inbox links a sub-agent's approval to
`/chat/<root>?subagent=<id>`.
