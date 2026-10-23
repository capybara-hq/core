-- M6 T15：部署级插件配置存 PG（D8 / C10）。只存非密钥字段（按点路径嵌套的对象）；密钥字段各自加密存
-- capybara.secrets（namespace kernel、org_id '_deployment'、键 plugin-deployment-config:<plugin>:<path>）。
-- 优先级：环境变量 > 文件 / Nacos > 这里 > schema 默认值；文件或环境变量里有的字段只读。
-- 内置、配置声明与安装记录的插件都可以在这里配；卸载插件不删这一行（数据保留）。
CREATE TABLE IF NOT EXISTS plugin_deployment_configs (
  plugin text PRIMARY KEY,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_by text REFERENCES accounts(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
