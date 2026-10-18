-- 工具定义漂移检测与复核（spec 7.3）：新增 / 变化的工具在管理员复核前不可用。

-- 变化后待复核的新定义（复核前 spec / spec_hash / source 仍是上次复核通过的定义，供对比；通过后采用这里的）。
ALTER TABLE capybara.app_tools ADD COLUMN IF NOT EXISTS pending_spec jsonb;
ALTER TABLE capybara.app_tools ADD COLUMN IF NOT EXISTS pending_spec_hash text;
ALTER TABLE capybara.app_tools ADD COLUMN IF NOT EXISTS pending_source text
  CHECK (pending_source IS NULL OR pending_source IN ('connector', 'resources'));
-- 默认策略的来历：derived = 按注解推导（定义变化复核通过后重新推导）；admin = 管理员设定（保留）。
ALTER TABLE capybara.app_tools ADD COLUMN IF NOT EXISTS policy_source text NOT NULL DEFAULT 'derived'
  CHECK (policy_source IN ('derived', 'admin'));
-- 远端不再提供该工具的时间（工具随之停用，行保留）；又出现时清空并按新增处理（待复核）。
ALTER TABLE capybara.app_tools ADD COLUMN IF NOT EXISTS missing_since timestamptz;

-- 最近一次成功拿到工具清单（安装 / 刷新 / 漂移检查）的时间。为空 = 从未拍过快照（OAuth 授权码应用安装时
-- 不 listTools，A16）：首个快照按安装处理（直接启用）。定时扫描据此跳过本周期内已检查过的应用。
ALTER TABLE capybara.apps ADD COLUMN IF NOT EXISTS tools_synced_at timestamptz;
UPDATE capybara.apps SET tools_synced_at = updated_at
  WHERE tools_synced_at IS NULL
    AND (auth->>'type' IS DISTINCT FROM 'oauth_code'
      OR EXISTS (SELECT 1 FROM capybara.app_tools t WHERE t.app_id = apps.id));
