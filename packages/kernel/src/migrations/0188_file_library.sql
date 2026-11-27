-- File library (docs/superpowers/specs/2026-11-27-file-library-design.md §1, §9): bytes become
-- per-org content-addressed blobs, files become account-owned rows, conversations refer to files.
-- This is the expand step: the tables, the `file_shares` columns and a copy of the existing data
-- with preserved ids (every logged ref resolves on the first request after the deploy). A later
-- contract migration drops `file_shares.object_key` and the chat purpose of `attachments`.
--
-- Search: pg_trgm is not assumed present, so name search is a `lower(name)` index (prefix queries)
-- plus `position(lower($q) in lower(name)) > 0` over one account's ready rows, bounded by the
-- library index.

-- The bytes. `object_key` is relative to `kernel/<org>/`: new blobs `blobs/<sha256>` (kernel
-- writes) or an adopted upload's staging key; migrated blobs keep their old key. `sha256` is null
-- only for a migrated blob the hashing job has not reached yet. `dedup_after`: from when another
-- account's upload may resolve to this blob. `gone`: the hashing job found the object missing.
CREATE TABLE IF NOT EXISTS blobs (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  sha256 text CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  size bigint NOT NULL CHECK (size >= 0),
  etag text,
  object_key text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'ready', 'deleting', 'gone')),
  dedup_after timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS blobs_org_sha256_key ON blobs (org_id, sha256)
  WHERE sha256 IS NOT NULL;
-- the hashing job's cursor
CREATE INDEX IF NOT EXISTS blobs_unhashed_idx ON blobs (org_id, id) WHERE sha256 IS NULL;
-- the sweep: pending intents and deletions under way
CREATE INDEX IF NOT EXISTS blobs_status_idx ON blobs (status, created_at) WHERE status <> 'ready';

-- What a person sees. `blob_id` is null only while `uploading`; `staging_key` is the staging object
-- of a migrated `uploading` row (its old `attachments/<id>` key; null for new rows, which stage at
-- `uploads/<id>`). `agent_id` has no foreign key: agents can be deleted, the library keeps the id
-- as a label. `expires_at` applies to `uploading` / `draft` only.
CREATE TABLE IF NOT EXISTS files (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  account_id text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  blob_id text REFERENCES blobs(id),
  name text NOT NULL,
  content_type text NOT NULL,
  size bigint NOT NULL,
  pages integer,
  origin text NOT NULL CHECK (origin IN ('upload', 'delivered', 'generated')),
  status text NOT NULL CHECK (status IN ('uploading', 'draft', 'ready', 'deleted')),
  agent_id text,
  source_conversation_id text REFERENCES conversations(id) ON DELETE SET NULL,
  source_path text,
  staging_key text,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT files_blob_check CHECK (status = 'uploading' OR blob_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS files_library_idx ON files (org_id, account_id, created_at DESC, id DESC)
  WHERE status = 'ready';
CREATE INDEX IF NOT EXISTS files_blob_idx ON files (blob_id);
CREATE INDEX IF NOT EXISTS files_expiry_idx ON files (expires_at)
  WHERE status IN ('uploading', 'draft');
CREATE INDEX IF NOT EXISTS files_deleted_idx ON files (deleted_at) WHERE status = 'deleted';
CREATE INDEX IF NOT EXISTS files_source_idx ON files (source_conversation_id, source_path);
CREATE INDEX IF NOT EXISTS files_name_lower_idx
  ON files (org_id, account_id, lower(name) text_pattern_ops) WHERE status = 'ready';

-- Which conversation refers to which file: `attached` (sent in a message) or `delivered`;
-- `first_seq` is the event that first referred to it (null when not known).
CREATE TABLE IF NOT EXISTS conversation_files (
  conversation_id text NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  file_id text NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  org_id text NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('attached', 'delivered')),
  first_seq bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, file_id)
);
CREATE INDEX IF NOT EXISTS conversation_files_file_idx ON conversation_files (file_id);

-- Shares point at blobs; a library share has no conversation; `object_key` stays only until the
-- contract migration.
ALTER TABLE file_shares ADD COLUMN IF NOT EXISTS blob_id text REFERENCES blobs(id);
ALTER TABLE file_shares ADD COLUMN IF NOT EXISTS source_file_id text
  REFERENCES files(id) ON DELETE SET NULL;
ALTER TABLE file_shares ALTER COLUMN conversation_id DROP NOT NULL;
-- capybara:allow-destructive replaced by a wider check right below (adds 'file_deleted')
ALTER TABLE file_shares DROP CONSTRAINT IF EXISTS file_shares_revoke_reason_check;
ALTER TABLE file_shares ADD CONSTRAINT file_shares_revoke_reason_check CHECK (revoke_reason IN
  ('creator', 'admin', 'conversation_deleted', 'member_offboarded', 'creator_lost_access',
   'file_deleted'));
CREATE INDEX IF NOT EXISTS file_shares_blob_idx ON file_shares (blob_id) WHERE blob_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS file_shares_source_file_idx ON file_shares (source_file_id);

DROP POLICY IF EXISTS org_scope ON blobs;
CREATE POLICY org_scope ON blobs USING (rls_admits(org_id)) WITH CHECK (rls_admits(org_id));
DROP POLICY IF EXISTS org_scope ON files;
CREATE POLICY org_scope ON files USING (rls_admits(org_id)) WITH CHECK (rls_admits(org_id));
DROP POLICY IF EXISTS org_scope ON conversation_files;
CREATE POLICY org_scope ON conversation_files USING (rls_admits(org_id))
  WITH CHECK (rls_admits(org_id));

-- Data copy. Every insert is ON CONFLICT DO NOTHING and every update guarded, so the file is a
-- no-op when run again. A migrated blob's id is derived from its org and key, so the blob and the
-- file rows compute the same id (and identical keys share one blob):
-- md5('blob:' || org_id || '/' || object_key)::uuid. Migrated blobs are `ready` with `sha256`
-- null (the hashing job fills it or merges duplicates) and `dedup_after` now.

-- 1 + 2. Chat attachments: ready ones get a blob (bound → `ready` file referenced by its
-- conversation, unbound → `draft` keeping `expires_at`); pending ones become `uploading` files
-- without a blob, their old key kept as `staging_key`.
INSERT INTO blobs (id, org_id, sha256, size, etag, object_key, status, dedup_after, created_at)
SELECT md5('blob:' || a.org_id || '/' || a.object_key)::uuid::text, a.org_id, NULL, a.size, a.etag,
       a.object_key, 'ready', now(), a.created_at
FROM attachments a
WHERE a.purpose = 'chat' AND a.status = 'ready'
ON CONFLICT DO NOTHING;

INSERT INTO files (id, org_id, account_id, blob_id, name, content_type, size, pages, origin, status,
                   agent_id, source_conversation_id, source_path, staging_key, expires_at,
                   created_at)
SELECT a.id, a.org_id, a.account_id,
       CASE WHEN a.status = 'ready'
            THEN md5('blob:' || a.org_id || '/' || a.object_key)::uuid::text END,
       a.name, a.content_type, a.size, a.pages, 'upload',
       CASE WHEN a.status = 'pending' THEN 'uploading'
            WHEN a.conversation_id IS NULL THEN 'draft'
            ELSE 'ready' END,
       NULL, a.conversation_id, NULL,
       CASE WHEN a.status = 'pending' THEN a.object_key END,
       CASE WHEN a.status = 'pending' OR a.conversation_id IS NULL THEN a.expires_at END,
       a.created_at
FROM attachments a
WHERE a.purpose = 'chat' AND a.status IN ('ready', 'pending')
ON CONFLICT DO NOTHING;

-- `first_seq`: the first user_message whose payload names the id (a message still queued has none
-- yet). The text scan runs once, per bound attachment, over its own conversation's messages.
INSERT INTO conversation_files (conversation_id, file_id, org_id, role, first_seq, created_at)
SELECT a.conversation_id, a.id, a.org_id, 'attached', m.seq, a.created_at
FROM attachments a
LEFT JOIN LATERAL (
  SELECT e.seq FROM conversation_events e
  WHERE e.conversation_id = a.conversation_id AND e.type = 'user_message'
    AND e.payload::text LIKE '%' || a.id || '%'
  ORDER BY e.seq LIMIT 1
) m ON true
WHERE a.purpose = 'chat' AND a.status = 'ready' AND a.conversation_id IS NOT NULL
ON CONFLICT DO NOTHING;

-- 3. Delivered artifacts: one file per distinct artifact id (its earliest event), owned by the
-- conversation's owner, rows of deleted conversations too (files stay). Every conversation that
-- logged the id refers to it from its first such event.
CREATE TEMPORARY TABLE IF NOT EXISTS file_library_artifacts ON COMMIT DROP AS
SELECT DISTINCT ON (e.payload->>'artifactId')
       e.payload->>'artifactId' AS id, c.org_id, c.account_id, c.agent_id, e.conversation_id,
       e.payload->>'objectKey' AS object_key, e.payload->>'name' AS name,
       e.payload->>'contentType' AS content_type, (e.payload->>'size')::bigint AS size,
       e.payload->>'sourcePath' AS source_path, e.created_at
FROM conversation_events e
JOIN conversations c ON c.id = e.conversation_id
WHERE e.type = 'artifact_created'
  AND e.payload->>'artifactId' IS NOT NULL AND e.payload->>'objectKey' IS NOT NULL
  AND e.payload->>'name' IS NOT NULL AND e.payload->>'contentType' IS NOT NULL
  AND e.payload->>'size' IS NOT NULL
ORDER BY e.payload->>'artifactId', e.created_at, e.seq;

INSERT INTO blobs (id, org_id, sha256, size, etag, object_key, status, dedup_after, created_at)
SELECT md5('blob:' || x.org_id || '/' || x.object_key)::uuid::text, x.org_id, NULL, x.size, NULL,
       x.object_key, 'ready', now(), x.created_at
FROM file_library_artifacts x
ON CONFLICT DO NOTHING;

INSERT INTO files (id, org_id, account_id, blob_id, name, content_type, size, origin, status,
                   agent_id, source_conversation_id, source_path, created_at)
SELECT x.id, x.org_id, x.account_id, md5('blob:' || x.org_id || '/' || x.object_key)::uuid::text,
       x.name, x.content_type, x.size,
       CASE WHEN x.source_path LIKE 'generated/%' THEN 'generated' ELSE 'delivered' END,
       'ready', x.agent_id, x.conversation_id, x.source_path, x.created_at
FROM file_library_artifacts x
ON CONFLICT DO NOTHING;

INSERT INTO conversation_files (conversation_id, file_id, org_id, role, first_seq, created_at)
SELECT e.conversation_id, x.id, x.org_id, 'delivered', min(e.seq), min(e.created_at)
FROM conversation_events e
JOIN file_library_artifacts x ON x.id = e.payload->>'artifactId'
JOIN conversations c ON c.id = e.conversation_id AND c.org_id = x.org_id
WHERE e.type = 'artifact_created'
GROUP BY e.conversation_id, x.id, x.org_id
ON CONFLICT DO NOTHING;

-- 4. Shares: each snapshot object becomes a blob the share points at (the blob owns the object
-- now, so `object_key` is cleared); `source_file_id` names the file when one has the share's id.
INSERT INTO blobs (id, org_id, sha256, size, etag, object_key, status, dedup_after, created_at)
SELECT md5('blob:' || s.org_id || '/' || s.object_key)::uuid::text, s.org_id, NULL, s.size, NULL,
       s.object_key, 'ready', now(), s.created_at
FROM file_shares s
WHERE s.object_key IS NOT NULL
ON CONFLICT DO NOTHING;

UPDATE file_shares s
SET blob_id = md5('blob:' || s.org_id || '/' || s.object_key)::uuid::text,
    source_file_id = (SELECT f.id FROM files f WHERE f.id = s.file_id AND f.org_id = s.org_id),
    object_key = NULL
WHERE s.object_key IS NOT NULL AND s.blob_id IS NULL;
