-- capybara:allow-destructive
DO $$
BEGIN
  EXECUTE format('ALTER TABLE %I RENAME TO %I', 't', 'u');
END
$$;
