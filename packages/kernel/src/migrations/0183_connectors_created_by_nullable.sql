-- Plugin pages spec §5.2.1 (ruling R17): the kernel creates template connectors as no person (a
-- plugin scope sync, the startup reconciliation), so such a connector has no creator. Relaxing NOT
-- NULL is expand-only: rows written before keep their creator, and dropping NOT NULL on a nullable
-- column is a no-op.
ALTER TABLE connectors ALTER COLUMN created_by DROP NOT NULL;
