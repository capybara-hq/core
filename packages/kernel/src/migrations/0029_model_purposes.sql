-- M6 T6：模型用途映射（C9）。org_id 为 NULL 的一行是部署默认（企业管理员设），组织可覆盖（组织管理员设）。
-- 用途是内核用途（目前只有 eval）或已加载插件 permissions.models 声明的；params 已按目标模型的声明校验。
-- 每个（组织 / 部署, 用途）至多一行：NULLS NOT DISTINCT 让部署默认也只有一行（需要 PG ≥ 15）。
CREATE TABLE IF NOT EXISTS model_purpose_mappings (
  org_id text REFERENCES orgs(id) ON DELETE CASCADE,
  purpose text NOT NULL,
  provider text NOT NULL,
  model text NOT NULL,
  params jsonb NOT NULL DEFAULT '{}',
  updated_by text REFERENCES accounts(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT model_purpose_mappings_scope_key UNIQUE NULLS NOT DISTINCT (org_id, purpose)
);
