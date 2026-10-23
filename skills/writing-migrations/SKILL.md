---
name: writing-migrations
description: 新增或修改 SQL 迁移（内核 packages/kernel/src/migrations 或插件 plugins/*/migrations）时使用：文件命名、幂等写法、扩展→收缩两步删列、破坏性语句的豁免注释与原因要求，以及如何本地运行 capybara migrate。
---

# 写迁移

迁移是纯 SQL 文件。`pnpm check:migrations`（也含在 `pnpm check` 里）逐条检查，下表的规则 id 就是它报出来的 id。

## 命名

`NNNN_<snake_desc>.sql`：四位数字、小写字母 / 数字 / 下划线，按数字顺序执行。例：`0002_add_label.sql`。不合规报 `naming`。已发布的迁移文件**不要改**，要改就新加一个。

位置：内核 `packages/kernel/src/migrations/`（schema `capybara`）；插件 `plugins/<name>/migrations/`（schema `plugin_<name>`，`-` 换成 `_`）。

## 迁移在哪个 schema 里跑

迁移器为每个文件包一层事务，并执行 `set local search_path to <该 schema>, public`。所以**表名不带 schema 前缀**；注意 `public` 排在后面：在本 schema 里找不到的名字会解析到 `public` 里的同名对象，所以不要依赖 `public` 里的东西，也别让表名与 `public` 里已有对象重名。

```sql
CREATE TABLE IF NOT EXISTS events (
  id bigserial PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now()
);
```

## 规则

| 规则 | 说明 | 规则 id |
|---|---|---|
| 建对象带 `IF NOT EXISTS` | `CREATE TABLE / INDEX / SCHEMA / EXTENSION / SEQUENCE` | `idempotent` |
| 删对象带 `IF EXISTS` | `DROP TABLE / INDEX / ...`、`DROP COLUMN IF EXISTS`、`DROP CONSTRAINT IF EXISTS` | `idempotent` |
| 不写事务控制 | 不要 `BEGIN` / `COMMIT` / `ROLLBACK` / `SAVEPOINT`；不要 `CREATE INDEX CONCURRENTLY`（事务内不能执行，用普通 `CREATE INDEX IF NOT EXISTS`） | `transaction-control` |
| 尽量不用 `DO` 块 | 其内部语句无法静态审查；能拆成普通幂等语句就拆。确需时（如 `RENAME COLUMN` 没有 `IF EXISTS`，要放进 `IF EXISTS (SELECT … information_schema.columns …) THEN … END IF` 才幂等），在 `DO` 行**正上方**写豁免注释，见下 | `do-block` |
| 破坏性语句要豁免 | 见下 | `destructive` |

破坏性语句 = 删列、`DROP TABLE` / `DROP SCHEMA`、`TRUNCATE`、`DELETE FROM`、含 `RENAME`、改列类型（`ALTER COLUMN ... TYPE`）。检查也扫描 `DO $$ … $$` 块体：块体里有这些语句、而 `DO` 行上方没有豁免注释时，除 `do-block` 外另报 `destructive`。写在 `$$` 里面的注释不算。块体里用 `EXECUTE` 拼出来的语句检查看不见，所以带豁免注释的 `DO` 块不论块体是否被识别为破坏性，原因都必填。

```sql
-- capybara:allow-destructive 表改名；同一发布内代码同步改名（项目未发布，无兼容层）
ALTER TABLE IF EXISTS apps RENAME TO connectors;
-- capybara:allow-destructive 列改名；同一发布内代码同步改名（项目未发布，无兼容层）
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'capybara' AND table_name = 'connector_tools' AND column_name = 'app_id') THEN
    ALTER TABLE connector_tools RENAME COLUMN app_id TO connector_id;
  END IF;
END
$$;
```

## 扩展 → 收缩（两步删列）

多副本滚动发布期间新旧版本代码同时在线，所以**不能在一个版本里既停止使用某列又把它删掉**。

版本 N（扩展）：加新列，代码改为读写新列，旧列不再使用但保留。

```sql
-- 0002_add_label.sql
ALTER TABLE events ADD COLUMN IF NOT EXISTS label text;
```

版本 N+1（收缩）：确认没有任何运行中的版本还读写旧列后，删除旧列。

```sql
-- 0003_drop_old_name.sql
-- capybara:allow-destructive 0002 起代码已全部改读 label，没有任何版本再读写 old_name
ALTER TABLE events DROP COLUMN IF EXISTS old_name;
```

## 豁免注释

- 写法：`-- capybara:allow-destructive <原因>`，必须在破坏性语句（或 `DO` 块的 `DO` 行）**紧邻的上一行**（中间不能隔空行或别的注释）。
- **原因不能为空**，且应说明为什么本版本可以直接执行（例如「该表是本版本新建、尚无数据」「已在上一个版本停止读写」）。写了标记但原因为空，仍报 `destructive`。
- 没有标记直接写破坏性语句，报 `destructive`。

## 本地运行

```bash
docker compose -f docker/compose.dev.yaml up -d      # postgres + valkey
export CAPYBARA_DB__URL=postgres://capybara:capybara@localhost:5432/capybara
export CAPYBARA_REDIS__URL=redis://localhost:6379
export CAPYBARA_MASTER_KEY=$(openssl rand -base64 32)
export CAPYBARA_PLUGINS='["@capybara-hq/plugin-example-counter"]'   # 要迁移哪些插件
pnpm capybara migrate
```

`capybara migrate` 先迁移内核，再按依赖顺序迁移 `CAPYBARA_PLUGINS` 里声明了 `migrations` 的插件，然后退出；已应用的文件不会重复执行。检查：`pnpm check:migrations`。
