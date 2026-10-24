-- M6 T23：企业目录条目与版本（D9 / C21 / C22）。四种 kind：plugin、connector-template、skill、app（T25）。
-- name：plugin 为插件清单名，skill 为 SKILL.md 的 name，connector-template 为去掉 scope 的 npm 包名。
-- package_name：条目的 npm 包名；同一条目的新版本必须来自同一个包（别的包用同名 → directory.name_conflict）。
-- 策略：allow（新导入默认）/ needs_approval / disabled，只挂在条目上。删除为软删除（deleted_at）：
-- 版本行与存储里的文件保留（已从目录安装的组件仍引用它们）；删除后同一 (kind, name) 可以重新导入成新条目。
CREATE TABLE IF NOT EXISTS directory_items (
  id uuid PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('plugin', 'connector-template', 'skill', 'app')),
  name text NOT NULL,
  package_name text NOT NULL,
  publisher text NOT NULL,
  display_name jsonb,
  description text NOT NULL,
  policy text NOT NULL DEFAULT 'allow' CHECK (policy IN ('allow', 'needs_approval', 'disabled')),
  latest_version text NOT NULL,
  created_by text REFERENCES accounts(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS directory_items_live_name_uq
  ON directory_items (kind, name)
  WHERE deleted_at IS NULL;

-- 每个导入的版本：section = package.json 的 capybara 段（原样）；source file / npm（T24 加 catalog），
-- source_ref：file 为 upload，npm 为 <包名>@<版本>；integrity：npm 下载时校验所用的 sha512（file 为空）。
-- plugin：plugin_sha256 指向包存储（plugin_packages），object_prefix 为空；
-- skill / connector-template：文件在对象存储 deployment/<object_prefix><path>，object_prefix =
-- directory/<item_id>/<version>/；files = [{ path, size, sha256 }]。resolved 留给应用包（T25）。
CREATE TABLE IF NOT EXISTS directory_item_versions (
  item_id uuid NOT NULL REFERENCES directory_items(id) ON DELETE CASCADE,
  version text NOT NULL,
  section jsonb NOT NULL,
  source text NOT NULL CHECK (source IN ('file', 'npm')),
  source_ref text NOT NULL,
  integrity text,
  object_prefix text,
  plugin_sha256 text REFERENCES plugin_packages(sha256),
  resolved jsonb,
  files jsonb NOT NULL DEFAULT '[]'::jsonb,
  size bigint NOT NULL CHECK (size > 0),
  imported_by text REFERENCES accounts(id) ON DELETE SET NULL,
  imported_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (item_id, version)
);

-- F-AA：经目录装到部署的插件记下来源条目（T26 据此让组织启用受目录策略约束）；不经目录安装时为空。
ALTER TABLE plugin_installs
  ADD COLUMN IF NOT EXISTS directory_item_id uuid REFERENCES directory_items(id) ON DELETE SET NULL;
