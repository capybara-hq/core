-- 第一段修复波 W2。
-- 卡片操作按 (连接, 卡片类型, 卡片 id) 找发出的卡片消息（channels/actions.ts，Ruling A13）；主键以会话打头用不上。
-- 卡片 id 是审批 / 提问 id（全局唯一，只属于一个会话），所以这三列本身唯一。
CREATE UNIQUE INDEX IF NOT EXISTS channel_card_messages_lookup_uq
  ON capybara.channel_card_messages (connection_id, card_kind, card_id);
-- 通讯录排除（0019）的外键列：删除账号时的级联 / 置空按它们查找。
CREATE INDEX IF NOT EXISTS directory_exclusions_account_idx
  ON capybara.directory_exclusions (account_id);
CREATE INDEX IF NOT EXISTS directory_exclusions_created_by_idx
  ON capybara.directory_exclusions (created_by);
