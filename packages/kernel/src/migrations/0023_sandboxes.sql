-- M5 T7：按对话的沙箱（sandbox@1 提供方的实例，见 sandbox/sandbox.service.ts）。每个对话至多一行。
-- 创建、恢复、休眠、销毁都在 Redis 锁 capk:sandbox:<conversation_id> 下进行；空闲休眠与不活跃销毁由维护队列扫描。
-- 不对 conversations / orgs 建外键：对话或组织删除后这一行要留着，直到维护任务销毁提供方那边的实例
-- （否则实例会泄漏）；对话已不存在的行在销毁后删除。
-- status：creating（正在创建，handle 为 NULL；创建失败或中途退出时停在这里，下次使用重新创建）
--   → running ⇄ suspended → destroyed（销毁后保留 handle 备查，下次使用重建）。
-- provider：创建它的插件名；与当前提供方不同时当作已不在，下次使用重建。
-- running_since：本次连续运行的开始时间（创建或恢复时写，休眠时清空），用于超时强制休眠。
-- generation：防护号。持锁方在锁内读到它，此后每次改 status / handle 都带 WHERE generation = 读到的值
--   并加一；没有匹配行说明锁已丢失、别人改过，放弃。
-- had_instance：曾经成功创建过实例（只会置 true，重置时不清）：之后的创建都算重建（recreated）。
-- prev_provider / prev_handle：换了提供方时旧提供方的实例（新提供方销毁不了），旧提供方还加载时用它销毁后清空。
-- sweep_failed_at：上次维护扫描处理它失败的时间（成功后清空）；扫描时排在后面，免得总卡在同一批。
CREATE TABLE IF NOT EXISTS sandboxes (
  conversation_id text PRIMARY KEY,
  org_id text NOT NULL,
  provider text NOT NULL,
  handle jsonb,
  status text NOT NULL CHECK (status IN ('creating', 'running', 'suspended', 'destroyed')),
  last_used_at timestamptz NOT NULL DEFAULT now(),
  running_since timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  suspended_at timestamptz,
  destroyed_at timestamptz,
  generation integer NOT NULL DEFAULT 0,
  had_instance boolean NOT NULL DEFAULT false,
  prev_provider text,
  prev_handle jsonb,
  sweep_failed_at timestamptz
);
CREATE INDEX IF NOT EXISTS sandboxes_running_idx
  ON sandboxes (last_used_at)
  WHERE status = 'running';
CREATE INDEX IF NOT EXISTS sandboxes_live_idx
  ON sandboxes (last_used_at)
  WHERE status <> 'destroyed';
CREATE INDEX IF NOT EXISTS sandboxes_org_idx ON sandboxes (org_id);
