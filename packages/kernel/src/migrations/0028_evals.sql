-- M6 T3：评测集、用例、评测运行与结果（D4、C3–C7）。一个评测集对应一个 agent；用例是某次真实运行的日志快照
-- （eval_cases.snapshot，≤ evals.maxCaseBytes），不引用原对话：原对话删除后用例照常可读、可回放。
-- 评测数据只在本组织内；删除评测集为软删除（deleted_at）。eval_runs / eval_results 由 T4 起写入。
CREATE TABLE IF NOT EXISTS eval_sets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  agent_id text NOT NULL REFERENCES agents(id),
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  -- 评委评分标准（T6）；NULL = 用默认标准
  rubric text,
  created_by text NOT NULL REFERENCES accounts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX IF NOT EXISTS eval_sets_org_idx ON eval_sets (org_id, created_at DESC) WHERE deleted_at IS NULL;

-- source_conversation_id / source_run_id 只是来源记录，不设外键（原对话可被删除）。
-- replayable_steps = replayableCalls(snapshot).length，写入时算好，列表不必读快照。
CREATE TABLE IF NOT EXISTS eval_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  set_id uuid NOT NULL REFERENCES eval_sets(id) ON DELETE CASCADE,
  org_id text NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  source_conversation_id text NOT NULL,
  source_run_id text NOT NULL,
  agent_version integer NOT NULL,
  title text NOT NULL,
  snapshot jsonb NOT NULL,
  snapshot_bytes integer NOT NULL CHECK (snapshot_bytes >= 0),
  replayable_steps integer NOT NULL DEFAULT 0 CHECK (replayable_steps >= 0),
  added_by text NOT NULL REFERENCES accounts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (set_id, source_run_id)
);

CREATE TABLE IF NOT EXISTS eval_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  set_id uuid NOT NULL REFERENCES eval_sets(id) ON DELETE CASCADE,
  mode text NOT NULL CHECK (mode IN ('step', 'run')),
  candidate jsonb NOT NULL,
  judge boolean NOT NULL DEFAULT false,
  token_cap bigint NOT NULL CHECK (token_cap > 0),
  tokens_used bigint NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'completed', 'cancelled', 'capped', 'failed')),
  cases_total integer NOT NULL,
  cases_done integer NOT NULL DEFAULT 0,
  -- 连续出错的结果数（成功即清零）；达到 evals.maxConsecutiveErrors 时运行置 failed，原因记在 error
  consecutive_errors integer NOT NULL DEFAULT 0,
  -- 运行失败的原因 {code, message}（英文；界面按 code 走 i18n）
  error jsonb,
  estimate jsonb NOT NULL,
  created_by text NOT NULL REFERENCES accounts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz
);
CREATE INDEX IF NOT EXISTS eval_runs_set_idx ON eval_runs (set_id, created_at DESC);

CREATE TABLE IF NOT EXISTS eval_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES eval_runs(id) ON DELETE CASCADE,
  case_id uuid NOT NULL REFERENCES eval_cases(id) ON DELETE CASCADE,
  org_id text NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  step integer,
  model_call_seq bigint,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'done', 'error', 'skipped')),
  baseline jsonb,
  candidate jsonb,
  diff jsonb,
  judge jsonb,
  drift text[] NOT NULL DEFAULT '{}',
  error jsonb,
  eval_conversation_id text,
  -- 认领该结果的任务尝试（每次执行一个新 uuid）：写 done 与计费都以它为条件，失去认领的旧执行者写不进来
  claimed_by text,
  label text CHECK (label IN ('pass', 'fail')),
  label_note text,
  labeled_by text REFERENCES accounts(id) ON DELETE SET NULL,
  labeled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS eval_results_run_idx ON eval_results (run_id, id);
CREATE INDEX IF NOT EXISTS eval_results_case_idx ON eval_results (case_id);

-- 对话种类：chat（普通对话）/ eval（整轮回放用的隐藏对话，T5；不在「我的对话」里）。
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'chat' CHECK (kind IN ('chat', 'eval'));
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS eval_run_id uuid REFERENCES eval_runs(id) ON DELETE SET NULL;
-- 轨迹列表（TrajectoryService.list）不按 agent 筛选时按 (org_id, kind) 取、按 (updated_at, id) 倒序
CREATE INDEX IF NOT EXISTS conversations_org_kind_idx
  ON conversations (org_id, kind, updated_at DESC, id DESC);
