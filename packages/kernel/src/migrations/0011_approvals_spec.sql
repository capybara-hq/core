-- 审批记录所批准的工具定义：spec_hash 用于写「本会话 / 以后都允许」授权（定义变化后授权失效）；
-- app_id 为应用工具的来源应用（详情展示用，插件 / 内置工具为空）。
-- 必填：approvals 是本版本（0010）新建的表，尚无数据，可直接加 NOT NULL 列。
ALTER TABLE capybara.approvals ADD COLUMN IF NOT EXISTS spec_hash text NOT NULL;
ALTER TABLE capybara.approvals ADD COLUMN IF NOT EXISTS app_id text
  REFERENCES capybara.apps(id) ON DELETE SET NULL;

-- 按角色升级的待处理审批（列表查询用）。
CREATE INDEX IF NOT EXISTS approvals_pending_role_idx
  ON capybara.approvals (org_id, approver_role) WHERE status = 'pending' AND approver_role IS NOT NULL;
