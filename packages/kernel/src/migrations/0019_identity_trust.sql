-- 第一段修复波 W1（Ruling A18 / A20）。
-- 身份行是怎么建立的：bind = IM 里点绑定链接确认（只证明网页登录者点了链接，不证明他控制该 IM 身份），
-- sso = 第三方登录，directory = 通讯录同步，local = 本地登录名。NULL 为此前的旧行，按 sso 处理。
-- 第三方登录拒绝 bind（以及不受信任租户的 directory）身份，除非本人已登录同一账号（此时升级为 sso）。
ALTER TABLE capybara.identities ADD COLUMN IF NOT EXISTS linked_via text
  CHECK (linked_via IN ('bind', 'sso', 'directory', 'local'));
UPDATE capybara.identities SET linked_via = 'local' WHERE source = 'local' AND linked_via IS NULL;
-- 通讯录排除：管理员手动移出（或本人离开）由通讯录同步加入的成员后，同步不再把此人加回该组织，
-- 直到有人手动重新加入（接受邀请等），届时删除这一行。
CREATE TABLE IF NOT EXISTS capybara.directory_exclusions (
  org_id text NOT NULL REFERENCES capybara.orgs(id) ON DELETE CASCADE,
  account_id text NOT NULL REFERENCES capybara.accounts(id) ON DELETE CASCADE,
  plugin text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text REFERENCES capybara.accounts(id) ON DELETE SET NULL,
  PRIMARY KEY (org_id, account_id, plugin)
);
