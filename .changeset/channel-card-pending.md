---
"@capybara-hq/kernel": patch
"@capybara-hq/testing": patch
---

Channel delivery now records an approval / question card in `channel_card_messages` as `pending`
before sending it, and fills in the message id (`status = 'sent'`) in the transaction that advances
`last_seq`. A click on a card that shows up before the send returns is accepted; a click on the
card from another connection or chat is still refused (Ruling A13). After a crash the card is
resent with the same idempotency key; a card update never targets a card without a message id.
Migration `0039_channel_card_pending.sql` makes `message_id` nullable and adds `status`. The fake
channel server gains `delayNext(path, delayMs, { count, onlyCards })`, which delays the send /
update response while the message is already visible.
Known limitation (Ruling R5): Slack ignores `idempotencyKey`, so a crash between the send and
`advance` can show a duplicate card on Slack whose first copy does not reflect the decision.
