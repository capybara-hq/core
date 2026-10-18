-- 工具定义快照（内容寻址）：model_call 只记 {key, specHash}，定义本身按指纹存这里，只增不改。
-- 应用刷新、插件升级改了定义之后，早先 model_call 用过的定义仍可按指纹取回，模型请求可由日志还原。
-- spec 为 ToolSpec（name 为来源内的原名；模型可见名是 model_call 里的 key）。
CREATE TABLE IF NOT EXISTS tool_specs (
  spec_hash text PRIMARY KEY,
  spec jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
