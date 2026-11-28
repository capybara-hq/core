-- File library (docs/superpowers/specs/2026-11-27-file-library-design.md §1, §9): bytes become
-- per-org content-addressed blobs, files become account-owned rows, conversations refer to files.
-- This is the expand step: the tables, the `file_shares` columns and the copy function. A later
-- contract migration drops `file_shares.object_key` and the chat purpose of `attachments`.
--
-- The data copy is the function `file_library_copy(since)` defined here, run by
-- 0191_file_library_copy.sql in its own transaction (so this file's DDL locks are not held while
-- it scans). It copies chat attachments, `artifact_created` artifacts and share snapshots with
-- preserved ids (every logged ref resolves on the first request after the deploy), restricted to
-- source rows created at or after `since` ('-infinity' = everything), and catches up the rows old
-- code changed after an earlier copy (a draft now bound, an upload now finalized, a share whose
-- snapshot generation moved on). During a rolling deploy old replicas keep writing the old tables,
-- so the kernel calls it again from a one-off catch-up job after the rolling window, before the
-- hashing job merges any blob (a share repointed to a merged blob would otherwise look like a moved
-- snapshot generation and be pointed back at the deleted duplicate). It is idempotent: every
-- insert is ON CONFLICT DO NOTHING, every update guarded.
--
-- `file_shares.object_key` is kept as is (old replicas still read it for liveness and the share
-- sweep); `blob_id` is the new reference.
--
-- Search: pg_trgm is not assumed present, so name search is a `lower(name)` index (prefix queries)
-- plus `position(lower($q) in lower(name)) > 0` over one account's ready rows, bounded by the
-- library index.

-- The bytes. `object_key` is relative to `kernel/<org>/`: new blobs `blobs/<blobId>` (every one
-- written by the kernel: a delivery, or a finalized upload's verified copy); migrated blobs keep
-- their old key. `sha256` is null while `pending` and for a migrated blob the hashing job has not
-- reached yet. `dedup_after`: from when another account's upload may resolve to this blob (now()
-- for kernel-written blobs). `gone`: the hashing job found the object missing.
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
-- one blob per object
CREATE UNIQUE INDEX IF NOT EXISTS blobs_org_object_key ON blobs (org_id, object_key);
-- the hashing job's cursor
CREATE INDEX IF NOT EXISTS blobs_unhashed_idx ON blobs (org_id, id) WHERE sha256 IS NULL;
-- the sweep: pending intents and deletions under way
CREATE INDEX IF NOT EXISTS blobs_status_idx ON blobs (status, created_at) WHERE status <> 'ready';

-- What a person sees. `blob_id` is null while `uploading` (and may be once `deleted`);
-- `staging_key` is the staging object of a migrated `uploading` row (its old `attachments/<id>`
-- key; null for new rows, which stage at `uploads/<id>`). `agent_id` has no foreign key: agents can
-- be deleted, the library keeps the id as a label. `expires_at` applies to `uploading` / `draft`.
-- `sha256`: an upload's declared hash at create, the verified one from finalize on (null for
-- deliveries and migrated rows); `upload_purpose`: where an upload was started (null otherwise).
-- `ref_key` / `ref_etag`: the object key and etag of the blob the file was first stored on, kept
-- when the file later moves to another blob (a hashing merge) so the unsigned reference and etag
-- the model saw stay the same in later requests and replays. With `ref_key` set, `ref_etag` is
-- taken as recorded (null: none); with no `ref_key`, the blob's own key and etag.
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
  sha256 text CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  upload_purpose text CHECK (upload_purpose IN ('composer', 'library')),
  ref_key text,
  ref_etag text,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT files_blob_check CHECK (status IN ('uploading', 'deleted') OR blob_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS files_library_idx ON files (org_id, account_id, created_at DESC, id DESC)
  WHERE status = 'ready';
CREATE INDEX IF NOT EXISTS files_blob_idx ON files (blob_id);
-- the instant path of an upload: the caller's own files with these bytes
CREATE INDEX IF NOT EXISTS files_account_sha256_idx ON files (org_id, account_id, sha256)
  WHERE sha256 IS NOT NULL;
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

-- Shares point at blobs; a library share has no conversation.
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

-- The data copy (see the header). A migrated blob's id is derived from its org and key,
-- md5('blob:' || org_id || '/' || object_key)::uuid; inserts that reference a blob resolve it by
-- (org_id, object_key), so a blob written by new code under the same key is reused. Migrated blobs
-- are `ready` with `sha256` null (the hashing job fills it or merges duplicates).
CREATE OR REPLACE FUNCTION file_library_copy(since timestamptz) RETURNS void
LANGUAGE plpgsql
SET search_path TO capybara, public
AS $$
BEGIN
  -- 1. Chat attachments. A blob for every ready one in range, and for those whose migrated
  -- `uploading` file waits for them (finalized by old code after an earlier copy).
  INSERT INTO blobs (id, org_id, sha256, size, etag, object_key, status, dedup_after, created_at)
  SELECT md5('blob:' || a.org_id || '/' || a.object_key)::uuid::text, a.org_id, NULL, a.size,
         a.etag, a.object_key, 'ready', now(), a.created_at
  FROM attachments a
  WHERE a.purpose = 'chat' AND a.status = 'ready'
    AND (a.created_at >= since
         OR EXISTS (SELECT 1 FROM files f WHERE f.id = a.id AND f.status = 'uploading'))
  ON CONFLICT DO NOTHING;

  -- ready + bound → `ready`; ready + unbound → `draft` (keeps `expires_at`); pending →
  -- `uploading` without a blob, its old key kept as `staging_key`
  INSERT INTO files (id, org_id, account_id, blob_id, name, content_type, size, pages, origin,
                     status, agent_id, source_conversation_id, source_path, staging_key,
                     ref_key, ref_etag, expires_at, created_at)
  SELECT a.id, a.org_id, a.account_id, b.id, a.name, a.content_type, a.size, a.pages, 'upload',
         CASE WHEN a.status = 'pending' THEN 'uploading'
              WHEN a.conversation_id IS NULL THEN 'draft'
              ELSE 'ready' END,
         NULL, a.conversation_id, NULL,
         CASE WHEN a.status = 'pending' THEN a.object_key END,
         b.object_key, b.etag,
         CASE WHEN a.status = 'pending' OR a.conversation_id IS NULL THEN a.expires_at END,
         a.created_at
  FROM attachments a
  LEFT JOIN blobs b ON a.status = 'ready' AND b.org_id = a.org_id AND b.object_key = a.object_key
  WHERE a.purpose = 'chat' AND a.status IN ('ready', 'pending') AND a.created_at >= since
  ON CONFLICT DO NOTHING;

  -- catch-up: an `uploading` file whose attachment old code finalized
  UPDATE files f
  SET blob_id = b.id,
      ref_key = b.object_key,
      ref_etag = b.etag,
      status = CASE WHEN a.conversation_id IS NULL THEN 'draft' ELSE 'ready' END,
      size = a.size,
      pages = a.pages,
      staging_key = NULL,
      source_conversation_id = a.conversation_id,
      expires_at = CASE WHEN a.conversation_id IS NULL THEN a.expires_at END
  FROM attachments a
  JOIN blobs b ON b.org_id = a.org_id AND b.object_key = a.object_key
  WHERE f.id = a.id AND f.org_id = a.org_id AND f.status = 'uploading' AND f.origin = 'upload'
    AND a.purpose = 'chat' AND a.status = 'ready';

  -- catch-up: a `draft` file whose attachment old code bound to a message
  UPDATE files f
  SET status = 'ready', expires_at = NULL, source_conversation_id = a.conversation_id
  FROM attachments a
  WHERE f.id = a.id AND f.org_id = a.org_id AND f.status = 'draft' AND f.origin = 'upload'
    AND a.purpose = 'chat' AND a.status = 'ready' AND a.conversation_id IS NOT NULL;

  -- every bound attachment whose ready file is not referenced yet; `first_seq` is the first
  -- user_message whose content names it (a message still queued has none yet)
  INSERT INTO conversation_files (conversation_id, file_id, org_id, role, first_seq, created_at)
  SELECT a.conversation_id, a.id, a.org_id, 'attached', m.seq, a.created_at
  FROM attachments a
  JOIN files f ON f.id = a.id AND f.org_id = a.org_id AND f.status = 'ready'
  LEFT JOIN LATERAL (
    SELECT e.seq FROM conversation_events e
    WHERE e.conversation_id = a.conversation_id AND e.type = 'user_message'
      AND jsonb_path_exists(e.payload,
        '$.content[*].source ? (@.attachmentId == $id || @.fileId == $id)',
        jsonb_build_object('id', a.id))
    ORDER BY e.seq LIMIT 1
  ) m ON true
  WHERE a.purpose = 'chat' AND a.status = 'ready' AND a.conversation_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM conversation_files cf
                    WHERE cf.conversation_id = a.conversation_id AND cf.file_id = a.id)
  ON CONFLICT DO NOTHING;

  -- 2. Delivered artifacts in range: one file per artifact id (its earliest event), owned by its
  -- conversation's owner, deleted conversations included (files stay); every conversation that
  -- logged the id refers to it from its first such event. One statement, so the events are
  -- scanned once (the foreign keys of the sibling inserts are checked at the statement's end).
  WITH ev AS MATERIALIZED (
    SELECT e.conversation_id, e.seq, e.created_at, c.org_id, c.account_id, c.agent_id,
           e.payload->>'artifactId' AS id, e.payload->>'objectKey' AS object_key,
           e.payload->>'name' AS name, e.payload->>'contentType' AS content_type,
           (e.payload->>'size')::bigint AS size, e.payload->>'sourcePath' AS source_path
    FROM conversation_events e
    JOIN conversations c ON c.id = e.conversation_id
    WHERE e.type = 'artifact_created' AND e.created_at >= since
      AND e.payload->>'artifactId' IS NOT NULL AND e.payload->>'objectKey' IS NOT NULL
      AND e.payload->>'name' IS NOT NULL AND e.payload->>'contentType' IS NOT NULL
      AND e.payload->>'size' IS NOT NULL
  ),
  x AS (
    SELECT DISTINCT ON (id) * FROM ev ORDER BY id, created_at, seq
  ),
  new_blobs AS (
    INSERT INTO blobs (id, org_id, sha256, size, etag, object_key, status, dedup_after,
                       created_at)
    SELECT DISTINCT ON (org_id, object_key)
           md5('blob:' || org_id || '/' || object_key)::uuid::text, org_id, NULL, size, NULL,
           object_key, 'ready', now(), created_at
    FROM x ORDER BY org_id, object_key, created_at
    ON CONFLICT DO NOTHING
    RETURNING id, org_id, object_key
  ),
  all_blobs AS (
    SELECT id, org_id, object_key FROM new_blobs
    UNION ALL
    SELECT b.id, b.org_id, b.object_key FROM blobs b
    WHERE EXISTS (SELECT 1 FROM x WHERE x.org_id = b.org_id AND x.object_key = b.object_key)
  ),
  new_files AS (
    INSERT INTO files (id, org_id, account_id, blob_id, name, content_type, size, origin, status,
                       agent_id, source_conversation_id, source_path, ref_key, created_at)
    SELECT x.id, x.org_id, x.account_id, ab.id, x.name, x.content_type, x.size,
           CASE WHEN x.source_path LIKE 'generated/%' THEN 'generated' ELSE 'delivered' END,
           'ready', x.agent_id, x.conversation_id, x.source_path, ab.object_key, x.created_at
    FROM x JOIN all_blobs ab ON ab.org_id = x.org_id AND ab.object_key = x.object_key
    ON CONFLICT DO NOTHING
    RETURNING id
  )
  INSERT INTO conversation_files (conversation_id, file_id, org_id, role, first_seq, created_at)
  SELECT ev.conversation_id, ev.id, ev.org_id, 'delivered', min(ev.seq), min(ev.created_at)
  FROM ev
  WHERE EXISTS (SELECT 1 FROM new_files nf WHERE nf.id = ev.id)
     OR EXISTS (SELECT 1 FROM files f WHERE f.id = ev.id AND f.org_id = ev.org_id)
  GROUP BY ev.conversation_id, ev.id, ev.org_id
  ON CONFLICT DO NOTHING;

  -- 3. Shares: each snapshot object becomes a blob the share points at; also when old code moved
  -- the share to a new snapshot generation after an earlier copy. `source_file_id` names the file
  -- when one has the share's `file_id`. `object_key` stays (old replicas read it).
  INSERT INTO blobs (id, org_id, sha256, size, etag, object_key, status, dedup_after, created_at)
  SELECT md5('blob:' || s.org_id || '/' || s.object_key)::uuid::text, s.org_id, NULL, s.size,
         NULL, s.object_key, 'ready', now(), s.created_at
  FROM file_shares s
  LEFT JOIN blobs cur ON cur.id = s.blob_id
  WHERE s.object_key IS NOT NULL AND s.updated_at >= since
    AND cur.object_key IS DISTINCT FROM s.object_key
  ON CONFLICT DO NOTHING;

  UPDATE file_shares s
  SET blob_id = b.id,
      source_file_id = coalesce(s.source_file_id,
        (SELECT f.id FROM files f WHERE f.id = s.file_id AND f.org_id = s.org_id))
  FROM blobs b
  WHERE b.org_id = s.org_id AND b.object_key = s.object_key AND s.updated_at >= since
    AND s.blob_id IS DISTINCT FROM b.id;
END
$$;
