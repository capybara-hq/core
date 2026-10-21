-- M5 T15：共享 agent 的技能变更申请（R4）。agent 用 skill_write 改自己的技能时，共享 agent（visibility 不是
-- private）不直接生成版本，而是在这里记一条申请，等该 agent 的负责人批准。
-- proposed_version = { skillId, version, manifest: { name, description, files: [{ path, size, sha256 }] } }：
--   skillId 为已有技能的 id，或新技能预先分配的 id（批准时用它建 skills 行）；version 是批准后预期的版本号。
-- object_prefix 是草稿文件在 kernel/<org_id>/ 下的键前缀（以 / 结尾），批准后原样成为该版本的 object_prefix；
--   拒绝 / 取消时删除。
-- skill_id 为 null 表示新技能。pending 期间只有发起对话（requested_in_conversation）用草稿版本（试用）。
CREATE TABLE IF NOT EXISTS skill_change_requests (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  agent_id text NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  skill_id text REFERENCES skills(id) ON DELETE CASCADE,
  proposed_version jsonb NOT NULL,
  object_prefix text NOT NULL,
  requested_by_account text NOT NULL REFERENCES accounts(id),
  requested_in_conversation text NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  decided_by text REFERENCES accounts(id),
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- 同一 agent 的同名技能最多一条待处理的申请（同一对话再写会取代旧的，别的对话再写被拒绝）
CREATE UNIQUE INDEX IF NOT EXISTS skill_change_requests_pending_name_uq
  ON skill_change_requests (agent_id, (proposed_version -> 'manifest' ->> 'name'))
  WHERE status = 'pending';
-- 运行开始解析技能目录时按发起对话找试用中的申请
CREATE INDEX IF NOT EXISTS skill_change_requests_conversation_idx
  ON skill_change_requests (requested_in_conversation)
  WHERE status = 'pending';
-- 收件箱：按组织列出待处理的申请
CREATE INDEX IF NOT EXISTS skill_change_requests_org_pending_idx
  ON skill_change_requests (org_id, created_at)
  WHERE status = 'pending';
