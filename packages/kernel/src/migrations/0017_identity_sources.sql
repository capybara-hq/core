-- 外部身份（M4）：成员关系的来源。NULL = 手动加入 / 凭邀请；"directory:<插件名>" = 通讯录同步加入
-- （通讯录同步只撤销由它自己加入的成员关系）。
ALTER TABLE capybara.memberships ADD COLUMN IF NOT EXISTS source text;
