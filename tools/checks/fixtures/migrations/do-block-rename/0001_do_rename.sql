DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 't' AND column_name = 'a') THEN
    ALTER TABLE t RENAME COLUMN a TO b;
  END IF;
END
$$;
