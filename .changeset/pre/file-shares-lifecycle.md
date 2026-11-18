---
"@capybara-hq/kernel": minor
---

Shares follow their conversation and creator: deleting a conversation or offboarding a member
revokes their shares in the same transaction and owes the snapshots' deletion through the outbox. A
daily sweep (`share-sweep`, worker role) revokes shares whose creator lost access
(`creator_lost_access`), frees the snapshots of shares expired or revoked more than seven days ago
(rows kept) and deletes orphan objects under `shares/` older than one hour.
