-- M6 T25：应用包（app.yaml）企业导入的暂存（C31）。prepare 校验完整个应用包（全部插件按 lock 下载并按 sha512
-- 校验、模板、技能）后写一行，confirm 按 reviewHash 一次批准并删除该行；24 小时过期，由维护任务
-- app-staging-cleanup 删除过期行与 object_prefix 下的对象（插件包留在内容寻址的 plugin_packages）。
-- review：给企业管理员看的审阅（AppReview）；bundle：确认时要用的解析结果（清单、文件、npm 包名、预定的条目 id、
-- 包大小）；source：{ kind: file | npm | catalog, ref, integrity?, catalogSourceId? }。
-- object_prefix：技能文件、图标与 app.yaml 在对象存储 deployment/<object_prefix><path>，确认后由版本行接管。
CREATE TABLE IF NOT EXISTS app_import_staging (
  id uuid PRIMARY KEY,
  review jsonb NOT NULL,
  bundle jsonb NOT NULL,
  object_prefix text,
  source jsonb NOT NULL,
  created_by text REFERENCES accounts(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS app_import_staging_expires_idx ON app_import_staging (expires_at);
