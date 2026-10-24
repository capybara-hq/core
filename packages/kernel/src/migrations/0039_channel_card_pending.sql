-- M7 T5a: outbound delivery records an approval / question card before sending it, so a click on a
-- card that is already visible on the platform is accepted (Ruling A13 finds the row). The row is
-- 'pending' with no message_id until the send returns; the transaction that advances
-- channel_deliveries.last_seq fills message_id and sets 'sent'. Existing rows were all sent.
ALTER TABLE channel_card_messages ALTER COLUMN message_id DROP NOT NULL;
ALTER TABLE channel_card_messages
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'sent'
    CHECK (status IN ('pending', 'sent'));
