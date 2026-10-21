-- M5 T3：对话附件（图片 / 文档）。字节在对象存储 kernel/<org_id>/attachments/<id>，这里只存元数据；
-- 用户的文件名只在 name 列，不进对象键。
-- status：pending（已登记、等浏览器直传并 finalize）→ ready（大小与类型已核对）；
-- deleting 是清理任务的认领状态（删对象失败时下次重试）。
-- conversation_id 在第一次被消息引用时绑定，之后不再变；未绑定的附件 expires_at 到期后由维护任务删除
-- （对象一并删除），绑定后 expires_at 置空。
CREATE TABLE IF NOT EXISTS attachments (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  conversation_id text REFERENCES conversations(id) ON DELETE CASCADE,
  account_id text NOT NULL REFERENCES accounts(id),
  name text NOT NULL,
  content_type text NOT NULL,
  size bigint NOT NULL CHECK (size >= 0),
  object_key text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'ready', 'deleting')),
  -- finalize 时记下的对象 etag：之后经同一预签名表单重传会改变 etag，取字节与下载时不符即视为不再可用
  etag text,
  -- PDF 的页数（finalize 时数出，用于 token 估算）；不是 PDF 或数不到为 NULL
  pages integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz
);
CREATE INDEX IF NOT EXISTS attachments_unbound_expiry_idx
  ON attachments (expires_at)
  WHERE conversation_id IS NULL;
CREATE INDEX IF NOT EXISTS attachments_conversation_idx
  ON attachments (conversation_id)
  WHERE conversation_id IS NOT NULL;
