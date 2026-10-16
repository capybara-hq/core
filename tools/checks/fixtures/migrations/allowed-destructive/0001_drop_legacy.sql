-- capybara:allow-destructive 旧列已在上一版本停止读写
ALTER TABLE capybara.t DROP COLUMN IF EXISTS legacy;
