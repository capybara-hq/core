-- D17：「应用 / app」（远端服务实例）改名「连接器 / connector」。表与 app_id 列改名；索引与约束名不改
-- （如 apps_org_slug_uniq、app_tools_policy_source_check）。secrets 键 credentials:app:*、已存 agent 版本里的
-- {kind:"app"}、事件 payload 的 appId 与旧审计记录 app.* 不改（C27）。不建兼容视图（C28）。

-- capybara:allow-destructive D17 应用 → 连接器全量改名；同一发布内代码与 web 同步改名（项目未发布，无兼容层，C28）
ALTER TABLE IF EXISTS apps RENAME TO connectors;
-- capybara:allow-destructive D17 应用 → 连接器全量改名；同一发布内代码与 web 同步改名（项目未发布，无兼容层，C28）
ALTER TABLE IF EXISTS app_tools RENAME TO connector_tools;

-- RENAME COLUMN 没有 IF EXISTS：按 information_schema 判断后再改，重复执行无副作用。
-- capybara:allow-destructive D17 应用 → 连接器全量改名；同一发布内代码与 web 同步改名（项目未发布，无兼容层，C28）
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['connector_tools', 'tool_grants', 'conversation_tool_grants', 'approvals'] LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'capybara' AND table_name = t AND column_name = 'app_id'
    ) THEN
      EXECUTE format('ALTER TABLE capybara.%I RENAME COLUMN app_id TO connector_id', t);
    END IF;
  END LOOP;
END
$$;
