-- M6 T24：目录来源（D16 / C25 / C26）。官方清单（id 'official'，builtin，地址来自配置 marketplaces.official.*，
-- 每次启动按配置同步）与企业清单（id 为 uuid，企业管理员维护；可选令牌存 secrets：namespace kernel、
-- org_id _deployment、键 catalog-token:<id>）。enabled：后台的启停（official 另受配置 marketplaces.official.enabled 约束）。
-- etag：上次成功拉取的 ETag（下次带 If-None-Match）；last_status：never / ok / error；拉取或校验失败保留上一份条目。
CREATE TABLE IF NOT EXISTS catalog_sources (
  id text PRIMARY KEY,
  name text NOT NULL,
  url text NOT NULL,
  mirrors jsonb NOT NULL DEFAULT '[]'::jsonb,
  builtin boolean NOT NULL DEFAULT false,
  enabled boolean NOT NULL DEFAULT true,
  etag text,
  last_refreshed_at timestamptz,
  last_status text NOT NULL DEFAULT 'never' CHECK (last_status IN ('ok', 'error', 'never')),
  last_error text,
  created_by text REFERENCES accounts(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- 每次成功刷新整体替换某个来源的条目（只供企业管理员浏览；引入时才物化为目录条目）。entry = 清单条目（已校验）。
CREATE TABLE IF NOT EXISTS catalog_entries (
  source_id text NOT NULL REFERENCES catalog_sources(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('plugin', 'connector-template', 'skill', 'app')),
  name text NOT NULL,
  npm text NOT NULL,
  entry jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source_id, kind, name)
);

-- 从清单引入的目录条目记下来源清单（来源删除后置空，条目保留）。
ALTER TABLE directory_items
  ADD COLUMN IF NOT EXISTS catalog_source_id text REFERENCES catalog_sources(id) ON DELETE SET NULL;

-- 版本来源增加 catalog（source_ref = <sourceId>:<npm>@<version>，integrity = 清单的 sha512）。
-- 约束名为 PG 对 0034 内联 CHECK 的默认命名。
ALTER TABLE directory_item_versions
  DROP CONSTRAINT IF EXISTS directory_item_versions_source_check;
ALTER TABLE directory_item_versions
  ADD CONSTRAINT directory_item_versions_source_check CHECK (source IN ('file', 'npm', 'catalog'));
