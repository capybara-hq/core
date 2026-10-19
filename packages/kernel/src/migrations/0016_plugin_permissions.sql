-- 插件已批准的权限快照（扩展模型 7.3）：插件首次出现或升级后清单比快照多出任何一项时不加载，待批准。
-- permissions = 规范化的权限集合（computePermissionSet）；source：cli = 管理员经 CLI 批准，auto = autoApprove 自动写入。
-- approved_by 为批准人账号 id（CLI 与自动批准没有账号，为空）。
CREATE TABLE IF NOT EXISTS capybara.plugin_permission_snapshots (
  plugin text PRIMARY KEY,
  version text NOT NULL,
  permissions jsonb NOT NULL,
  approved_by text,
  approved_at timestamptz NOT NULL DEFAULT now(),
  source text NOT NULL CHECK (source IN ('cli', 'auto'))
);
