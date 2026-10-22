-- M6 T11：插件安装记录、内容寻址包存储与各副本的加载状态（C13）。
-- 包按整个 tgz 的 sha256 寻址；字节放对象存储 deployment/plugins/blobs/<sha256>.tgz（blob_store = object），
-- 没有对象存储或由 CLI 写入时放 plugin_blobs（blob_store = pg，同受 packages.maxBytes 限制）。
-- name 是插件清单名，package_name 是 package.json 的 npm 包名（同名插件换了包名视为冲突）。
CREATE TABLE IF NOT EXISTS plugin_packages (
  sha256 text PRIMARY KEY CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  name text NOT NULL,
  package_name text NOT NULL,
  version text NOT NULL,
  size bigint NOT NULL CHECK (size > 0),
  section jsonb NOT NULL,
  blob_store text NOT NULL CHECK (blob_store IN ('object', 'pg')),
  source text NOT NULL CHECK (source IN ('npm', 'file', 'directory')),
  source_ref text NOT NULL,
  uploaded_by text REFERENCES accounts(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS plugin_packages_name_idx ON plugin_packages (name, created_at DESC);

CREATE TABLE IF NOT EXISTS plugin_blobs (
  sha256 text PRIMARY KEY REFERENCES plugin_packages(sha256) ON DELETE CASCADE,
  bytes bytea NOT NULL
);

-- 每插件一行：期望的版本与状态（后台只写这里，各副本收敛）。migrated_sha = 已执行过其迁移的包。
CREATE TABLE IF NOT EXISTS plugin_installs (
  name text PRIMARY KEY,
  sha256 text NOT NULL REFERENCES plugin_packages(sha256),
  version text NOT NULL,
  source text NOT NULL CHECK (source IN ('npm', 'file', 'directory')),
  desired_state text NOT NULL DEFAULT 'disabled' CHECK (desired_state IN ('enabled', 'disabled')),
  migrated_sha text,
  installed_by text REFERENCES accounts(id) ON DELETE SET NULL,
  installed_at timestamptz NOT NULL DEFAULT now(),
  updated_by text REFERENCES accounts(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 插件名归哪个 npm 包（Ruling P3）：第一次安装时写入，卸载不删。卸载保留数据、密钥、批准快照与组织启用，
-- 另一个 npm 包不能用同名插件接手这些。只上传、没安装过的包不占名字。
CREATE TABLE IF NOT EXISTS plugin_name_owners (
  name text PRIMARY KEY,
  package_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO plugin_name_owners (name, package_name)
SELECT plugin_installs.name, plugin_packages.package_name
FROM plugin_installs
JOIN plugin_packages ON plugin_packages.sha256 = plugin_installs.sha256
ON CONFLICT DO NOTHING;

-- 每个副本（进程）每个插件的加载结果；replica_id 是进程级的 <hostname>-<pid>-<6 位随机>，
-- http_replica_id 是配置的 http.replicaId（有就记，便于与 x-capybara-replica 对照）。
-- state = pending 时 reason 为 config / approval / migration / dependency。
CREATE TABLE IF NOT EXISTS plugin_replica_status (
  replica_id text NOT NULL,
  plugin text NOT NULL,
  version text NOT NULL,
  sha256 text,
  source text NOT NULL CHECK (source IN ('builtin', 'config', 'install')),
  state text NOT NULL CHECK (state IN ('loaded', 'failed', 'unloaded', 'pending')),
  reason text,
  detail text,
  http_replica_id text,
  heartbeat_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (replica_id, plugin)
);

CREATE INDEX IF NOT EXISTS plugin_replica_status_plugin_idx ON plugin_replica_status (plugin);
