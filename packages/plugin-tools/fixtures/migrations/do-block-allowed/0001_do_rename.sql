-- capybara:allow-destructive 表改名；同一发布内代码同步改名
ALTER TABLE IF EXISTS t RENAME TO u;
-- capybara:allow-destructive 列改名；同一发布内代码同步改名
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'u' AND column_name = 'a') THEN
    ALTER TABLE u RENAME COLUMN a TO b;
  END IF;
END
$$;
