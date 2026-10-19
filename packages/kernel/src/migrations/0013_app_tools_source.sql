-- 应用工具的来源：connector = 连接器 listTools 返回的工具；resources = 应用支持 resources 时内核补上的
-- list_resources / read_resource 两个工具（执行时路由到会话的 listResources / readResource）。
ALTER TABLE capybara.app_tools ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'connector'
  CHECK (source IN ('connector', 'resources'));
