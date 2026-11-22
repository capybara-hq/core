---
"@capybara-hq/kernel": patch
---

The command review and the tool review (Approve for me) read the person's recent messages in
conversation order again: they were passed newest first to a prompt that says oldest first, so the
review model took the person's latest message for their earliest and a tight budget dropped the
newest one. A person who changed their mind ("now enable it") was refused on their older request.
