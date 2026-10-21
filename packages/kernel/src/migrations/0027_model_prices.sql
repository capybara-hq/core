-- M6 T1：模型价格表（C2）。成本在读取时按这里的价格计算，不写进事件日志；单位为每百万 token，
-- 币种为部署设置 priceCurrency。由企业管理员录入；插件不声明价格。缓存读 / 写价为 NULL 时按输入价计。
CREATE TABLE IF NOT EXISTS model_prices (
  provider text NOT NULL,
  model text NOT NULL,
  input_per_mtok numeric NOT NULL CHECK (input_per_mtok >= 0),
  output_per_mtok numeric NOT NULL CHECK (output_per_mtok >= 0),
  cache_read_per_mtok numeric CHECK (cache_read_per_mtok >= 0),
  cache_write_per_mtok numeric CHECK (cache_write_per_mtok >= 0),
  updated_by text REFERENCES accounts(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, model)
);
-- 轨迹列表：按 agent 筛选、按最近更新倒序（TrajectoryService.list）
CREATE INDEX IF NOT EXISTS conversations_agent_idx ON conversations (org_id, agent_id, updated_at DESC);
