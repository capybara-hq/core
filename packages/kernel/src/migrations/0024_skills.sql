-- M5 T13：技能库。技能文件在对象存储 kernel/<org_id>/<skill_versions.object_prefix><path>，这里只存元数据。
-- scope：org（组织技能库，管理员上传，agent 定义里按 id 引用）/ agent（该 agent 自己的技能，自动对它生效，
--   T15 由 agent 提议、负责人批准后创建）；agent_id 只在 scope='agent' 时有值。
-- 同一作用域下未删除的技能按 name 唯一：上传同名技能包 = 新增一个版本（current_version + 1）。
-- 删除为软删除（deleted_at）；版本与对象保留（对象随组织数据清理一并删除）。
CREATE TABLE IF NOT EXISTS skills (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  scope text NOT NULL CHECK (scope IN ('org', 'agent')),
  agent_id text REFERENCES agents(id) ON DELETE CASCADE,
  name text NOT NULL,
  -- 当前版本 SKILL.md 的 description（列表直接读，不查版本）
  description text NOT NULL,
  current_version integer NOT NULL CHECK (current_version >= 1),
  created_by text NOT NULL REFERENCES accounts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CHECK ((scope = 'agent') = (agent_id IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS skills_live_name_uq
  ON skills (org_id, scope, coalesce(agent_id, ''), name)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS skills_agent_idx
  ON skills (agent_id)
  WHERE agent_id IS NOT NULL AND deleted_at IS NULL;

-- 每个版本的清单：manifest = { name, description, files: [{ path, size, sha256 }] }；
-- object_prefix 是该版本文件在 kernel/<org_id>/ 下的键前缀（以 / 结尾），文件键 = object_prefix || path。
CREATE TABLE IF NOT EXISTS skill_versions (
  skill_id text NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version >= 1),
  manifest jsonb NOT NULL,
  object_prefix text NOT NULL,
  created_by text NOT NULL REFERENCES accounts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (skill_id, version)
);
-- 清理未用上的技能包上传时按前缀判断文件是否已被某个版本引用
CREATE INDEX IF NOT EXISTS skill_versions_prefix_idx ON skill_versions (object_prefix);

-- 预签名上传的用途：chat（对话附件，可绑定到消息）/ skill-package（技能包 zip，只供 POST /skills 使用，
-- 不能绑定到消息、不能下载；有自己的待完成上限与过期时间）。已有的行都是对话附件。
ALTER TABLE attachments
  ADD COLUMN IF NOT EXISTS purpose text NOT NULL DEFAULT 'chat'
  CHECK (purpose IN ('chat', 'skill-package'));
