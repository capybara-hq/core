-- The platform icon setting (mobile layout spec §10.2.1): one row per uploaded purpose (the app
-- icon, its maskable variant, the SVG favicon), naming its object under the kernel's deployment/
-- prefix and the SHA-256 the public URL carries. No row: the web's built-in Capybara icon.
CREATE TABLE IF NOT EXISTS capybara.platform_icons (
  purpose text PRIMARY KEY CHECK (purpose IN ('app', 'maskable', 'favicon')),
  object_key text NOT NULL,
  sha256 text NOT NULL,
  content_type text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
