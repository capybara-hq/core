-- M6 T26：组织从企业目录安装（C22 / C31）、成员申请与审批。
-- directory_requests：成员申请（stage org，进组织管理员收件箱）与需审批条目的部署级申请（stage deployment，
-- 企业管理员决定）。同一组织、同一条目只能有一个 pending 申请（F-AF 部分唯一索引）。
CREATE TABLE IF NOT EXISTS directory_requests (
  id uuid PRIMARY KEY,
  org_id text NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  item_id uuid NOT NULL REFERENCES directory_items(id) ON DELETE CASCADE,
  version text,
  stage text NOT NULL CHECK (stage IN ('org', 'deployment')),
  requested_by text REFERENCES accounts(id) ON DELETE SET NULL,
  note text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  decided_by text REFERENCES accounts(id) ON DELETE SET NULL,
  decided_at timestamptz,
  -- 组织管理员批准后升级到 stage deployment 时记下批准人与时间（最终决定人仍记 decided_by）
  org_decided_by text REFERENCES accounts(id) ON DELETE SET NULL,
  org_decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS directory_requests_pending_uq
  ON directory_requests (org_id, item_id)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS directory_requests_stage_idx
  ON directory_requests (stage, status, created_at);

-- 企业管理员批准某组织安装 needs_approval 条目（跨版本有效）。
CREATE TABLE IF NOT EXISTS directory_org_grants (
  item_id uuid NOT NULL REFERENCES directory_items(id) ON DELETE CASCADE,
  org_id text NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  granted_by text REFERENCES accounts(id) ON DELETE SET NULL,
  granted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (item_id, org_id)
);

-- 应用在组织里的安装（C31）：失败的安装留行（status failed，error 只含步骤与错误码），可以重新安装。
CREATE TABLE IF NOT EXISTS app_installs (
  id uuid PRIMARY KEY,
  org_id text NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  item_id uuid NOT NULL REFERENCES directory_items(id) ON DELETE RESTRICT,
  version text NOT NULL,
  status text NOT NULL CHECK (status IN ('installing', 'installed', 'failed', 'uninstalling')),
  installed_by text REFERENCES accounts(id) ON DELETE SET NULL,
  installed_at timestamptz NOT NULL DEFAULT now(),
  error jsonb
);
CREATE UNIQUE INDEX IF NOT EXISTS app_installs_live_uq
  ON app_installs (org_id, item_id)
  WHERE status <> 'failed';

-- 应用安装的组件：created = 本次安装新建（false = 之前已存在）；技能新增版本时记 skill_version。
CREATE TABLE IF NOT EXISTS app_install_components (
  install_id uuid NOT NULL REFERENCES app_installs(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('plugin', 'connector', 'skill')),
  ref text NOT NULL,
  created boolean NOT NULL,
  skill_version integer,
  PRIMARY KEY (install_id, kind, ref)
);

-- 从目录安装的连接器 / 技能记下来源条目与版本（应用的组件记应用条目）。
ALTER TABLE connectors ADD COLUMN IF NOT EXISTS directory_item_id uuid
  REFERENCES directory_items(id) ON DELETE SET NULL;
ALTER TABLE connectors ADD COLUMN IF NOT EXISTS directory_version text;
-- 模板的 defaultToolPolicies：授权码连接器安装时没有工具快照，首个快照时按它设默认策略（policy_source 'template'）
ALTER TABLE connectors ADD COLUMN IF NOT EXISTS template_tool_policies jsonb;
ALTER TABLE skills ADD COLUMN IF NOT EXISTS directory_item_id uuid
  REFERENCES directory_items(id) ON DELETE SET NULL;
ALTER TABLE skills ADD COLUMN IF NOT EXISTS directory_version text;

-- 把插件带进部署的全部目录条目（插件条目装到部署、应用包确认时 install / upgrade 的插件）。同一插件可以有多个
-- 来源；组织直接启用（不经某个条目安装）时按全部来源的策略判定，最严格的生效（C22）。不经目录安装的插件没有行。
CREATE TABLE IF NOT EXISTS plugin_directory_sources (
  plugin text NOT NULL,
  item_id uuid NOT NULL REFERENCES directory_items(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (plugin, item_id)
);
INSERT INTO plugin_directory_sources (plugin, item_id)
  SELECT name, directory_item_id FROM plugin_installs WHERE directory_item_id IS NOT NULL
  ON CONFLICT DO NOTHING;

-- F-Z：模板安装的默认策略记 policy_source 'template'（约束名改名后不变）。
ALTER TABLE connector_tools DROP CONSTRAINT IF EXISTS app_tools_policy_source_check;
ALTER TABLE connector_tools DROP CONSTRAINT IF EXISTS connector_tools_policy_source_check;
ALTER TABLE connector_tools ADD CONSTRAINT connector_tools_policy_source_check
  CHECK (policy_source IN ('derived', 'admin', 'template'));
