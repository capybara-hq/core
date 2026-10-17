-- LangGraph checkpoint 存储（KyselyCheckpointSaver）：thread_id 约定为 runId；checkpoint / metadata / value
-- 为 serde.dumpsTyped 的字节，*_type 为其类型标记。运行结束后 pruneToLatest 只保留根命名空间最新一份。
CREATE TABLE IF NOT EXISTS capybara.lg_checkpoints (
  thread_id text NOT NULL,
  checkpoint_ns text NOT NULL DEFAULT '',
  checkpoint_id text NOT NULL,
  parent_checkpoint_id text,
  checkpoint_type text NOT NULL,
  checkpoint bytea NOT NULL,
  metadata_type text NOT NULL,
  metadata bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id)
);
CREATE TABLE IF NOT EXISTS capybara.lg_checkpoint_writes (
  thread_id text NOT NULL,
  checkpoint_ns text NOT NULL DEFAULT '',
  checkpoint_id text NOT NULL,
  task_id text NOT NULL,
  idx integer NOT NULL,
  channel text NOT NULL,
  value_type text NOT NULL,
  value bytea NOT NULL,
  task_path text NOT NULL DEFAULT '',
  PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id, task_id, idx)
);
