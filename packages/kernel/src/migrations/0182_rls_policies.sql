-- Row level security policies on every kernel table with an org_id column, shipped truly dark
-- (Postgres RLS spec, docs/superpowers/specs/2026-11-23-postgres-rls-design.md §4, §10; issue #115;
-- maintainer decision 2026-11-24). This migration only creates the helper and the policies: no
-- table enables row level security, so nothing applies them and nothing changes for any role
-- (pg_dump, COPY, query plans). Phase 5 runs ENABLE and FORCE ROW LEVEL SECURITY in a migration of
-- its own (FORCE: the kernel connects as the owner of the schema, which RLS otherwise exempts).
-- Once enabled, the policies admit every row unless a connection set capybara.rls = 'enforce',
-- which only the kernel pool does, under the kernel config db.rls = enforce.

-- The one rule: off unless enforcing; the platform scope sees every org; an org scope sees its
-- own rows. An unscoped enforcing connection has empty settings and matches no row (fail closed).
CREATE OR REPLACE FUNCTION rls_admits(row_org text) RETURNS boolean
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT coalesce(pg_catalog.current_setting('capybara.rls', true), '') <> 'enforce'
      OR pg_catalog.current_setting('capybara.scope', true) = 'platform'
      OR row_org = pg_catalog.current_setting('capybara.org_id', true)
$$;

DROP POLICY IF EXISTS org_scope ON device_retirement_obligations;
CREATE POLICY org_scope ON device_retirement_obligations USING (rls_admits(org_id)) WITH CHECK (rls_admits(org_id));

DROP POLICY IF EXISTS org_scope ON sandbox_operation_intents;
CREATE POLICY org_scope ON sandbox_operation_intents USING (rls_admits(org_id)) WITH CHECK (rls_admits(org_id));

DROP POLICY IF EXISTS org_scope ON org_data_keys;
CREATE POLICY org_scope ON org_data_keys USING (rls_admits(org_id)) WITH CHECK (rls_admits(org_id));

DROP POLICY IF EXISTS org_scope ON platform_sealed_reveals;
CREATE POLICY org_scope ON platform_sealed_reveals USING (rls_admits(org_id)) WITH CHECK (rls_admits(org_id));

DROP POLICY IF EXISTS org_scope ON memberships;
CREATE POLICY org_scope ON memberships USING (rls_admits(org_id)) WITH CHECK (rls_admits(org_id));

DROP POLICY IF EXISTS org_scope ON invitations;
CREATE POLICY org_scope ON invitations USING (rls_admits(org_id)) WITH CHECK (rls_admits(org_id));

DROP POLICY IF EXISTS org_scope ON api_tokens;
CREATE POLICY org_scope ON api_tokens USING (rls_admits(org_id)) WITH CHECK (rls_admits(org_id));

DROP POLICY IF EXISTS org_scope ON extension_org_configs;
CREATE POLICY org_scope ON extension_org_configs USING (rls_admits(org_id)) WITH CHECK (rls_admits(org_id));

DROP POLICY IF EXISTS org_scope ON extension_org_overrides;
CREATE POLICY org_scope ON extension_org_overrides USING (rls_admits(org_id)) WITH CHECK (rls_admits(org_id));

DROP POLICY IF EXISTS org_scope ON org_tool_switches;
CREATE POLICY org_scope ON org_tool_switches USING (rls_admits(org_id)) WITH CHECK (rls_admits(org_id));

DROP POLICY IF EXISTS org_scope ON org_network_allowances;
CREATE POLICY org_scope ON org_network_allowances USING (rls_admits(org_id)) WITH CHECK (rls_admits(org_id));

DROP POLICY IF EXISTS org_scope ON audit_events;
CREATE POLICY org_scope ON audit_events USING (rls_admits(org_id)) WITH CHECK (rls_admits(org_id));

DROP POLICY IF EXISTS org_scope ON secrets;
CREATE POLICY org_scope ON secrets USING (rls_admits(org_id)) WITH CHECK (rls_admits(org_id));

DROP POLICY IF EXISTS org_scope ON agents;
CREATE POLICY org_scope ON agents USING (rls_admits(org_id)) WITH CHECK (rls_admits(org_id));

DROP POLICY IF EXISTS org_scope ON conversations;
CREATE POLICY org_scope ON conversations USING (rls_admits(org_id)) WITH CHECK (rls_admits(org_id));

DROP POLICY IF EXISTS org_scope ON file_previewers;
CREATE POLICY org_scope ON file_previewers USING (rls_admits(org_id)) WITH CHECK (rls_admits(org_id));

DROP POLICY IF EXISTS org_scope ON org_extension_point_defaults;
CREATE POLICY org_scope ON org_extension_point_defaults USING (rls_admits(org_id)) WITH CHECK (rls_admits(org_id));

DROP POLICY IF EXISTS org_scope ON agent_templates;
CREATE POLICY org_scope ON agent_templates USING (rls_admits(org_id)) WITH CHECK (rls_admits(org_id));

DROP POLICY IF EXISTS org_scope ON connectors;
CREATE POLICY org_scope ON connectors USING (rls_admits(org_id)) WITH CHECK (rls_admits(org_id));

DROP POLICY IF EXISTS org_scope ON connector_tool_account_policies;
CREATE POLICY org_scope ON connector_tool_account_policies USING (rls_admits(org_id)) WITH CHECK (rls_admits(org_id));

DROP POLICY IF EXISTS org_scope ON tool_grants;
CREATE POLICY org_scope ON tool_grants USING (rls_admits(org_id)) WITH CHECK (rls_admits(org_id));

DROP POLICY IF EXISTS org_scope ON approvals;
CREATE POLICY org_scope ON approvals USING (rls_admits(org_id)) WITH CHECK (rls_admits(org_id));

DROP POLICY IF EXISTS org_scope ON permission_call_grants;
CREATE POLICY org_scope ON permission_call_grants USING (rls_admits(org_id)) WITH CHECK (rls_admits(org_id));

DROP POLICY IF EXISTS org_scope ON questions;
CREATE POLICY org_scope ON questions USING (rls_admits(org_id)) WITH CHECK (rls_admits(org_id));

DROP POLICY IF EXISTS org_scope ON tool_outputs;
CREATE POLICY org_scope ON tool_outputs USING (rls_admits(org_id)) WITH CHECK (rls_admits(org_id));

DROP POLICY IF EXISTS org_scope ON channel_connections;
CREATE POLICY org_scope ON channel_connections USING (rls_admits(org_id)) WITH CHECK (rls_admits(org_id));

DROP POLICY IF EXISTS org_scope ON org_anonymous_accounts;
CREATE POLICY org_scope ON org_anonymous_accounts USING (rls_admits(org_id)) WITH CHECK (rls_admits(org_id));

DROP POLICY IF EXISTS org_scope ON directory_exclusions;
CREATE POLICY org_scope ON directory_exclusions USING (rls_admits(org_id)) WITH CHECK (rls_admits(org_id));

DROP POLICY IF EXISTS org_scope ON attachments;
CREATE POLICY org_scope ON attachments USING (rls_admits(org_id)) WITH CHECK (rls_admits(org_id));

DROP POLICY IF EXISTS org_scope ON sandboxes;
CREATE POLICY org_scope ON sandboxes USING (rls_admits(org_id)) WITH CHECK (rls_admits(org_id));

DROP POLICY IF EXISTS org_scope ON devices;
CREATE POLICY org_scope ON devices USING (rls_admits(org_id)) WITH CHECK (rls_admits(org_id));

DROP POLICY IF EXISTS org_scope ON device_instances;
CREATE POLICY org_scope ON device_instances USING (rls_admits(org_id)) WITH CHECK (rls_admits(org_id));

DROP POLICY IF EXISTS org_scope ON device_defaults;
CREATE POLICY org_scope ON device_defaults USING (rls_admits(org_id)) WITH CHECK (rls_admits(org_id));

DROP POLICY IF EXISTS org_scope ON device_machines;
CREATE POLICY org_scope ON device_machines USING (rls_admits(org_id)) WITH CHECK (rls_admits(org_id));

DROP POLICY IF EXISTS org_scope ON background_tasks;
CREATE POLICY org_scope ON background_tasks USING (rls_admits(org_id)) WITH CHECK (rls_admits(org_id));

DROP POLICY IF EXISTS org_scope ON scheduled_tasks;
CREATE POLICY org_scope ON scheduled_tasks USING (rls_admits(org_id)) WITH CHECK (rls_admits(org_id));

DROP POLICY IF EXISTS org_scope ON scheduled_task_runs;
CREATE POLICY org_scope ON scheduled_task_runs USING (rls_admits(org_id)) WITH CHECK (rls_admits(org_id));

DROP POLICY IF EXISTS org_scope ON file_shares;
CREATE POLICY org_scope ON file_shares USING (rls_admits(org_id)) WITH CHECK (rls_admits(org_id));

DROP POLICY IF EXISTS org_scope ON skills;
CREATE POLICY org_scope ON skills USING (rls_admits(org_id)) WITH CHECK (rls_admits(org_id));

DROP POLICY IF EXISTS org_scope ON skill_change_requests;
CREATE POLICY org_scope ON skill_change_requests USING (rls_admits(org_id)) WITH CHECK (rls_admits(org_id));

DROP POLICY IF EXISTS org_scope ON eval_sets;
CREATE POLICY org_scope ON eval_sets USING (rls_admits(org_id)) WITH CHECK (rls_admits(org_id));

DROP POLICY IF EXISTS org_scope ON eval_cases;
CREATE POLICY org_scope ON eval_cases USING (rls_admits(org_id)) WITH CHECK (rls_admits(org_id));

DROP POLICY IF EXISTS org_scope ON eval_runs;
CREATE POLICY org_scope ON eval_runs USING (rls_admits(org_id)) WITH CHECK (rls_admits(org_id));

DROP POLICY IF EXISTS org_scope ON eval_results;
CREATE POLICY org_scope ON eval_results USING (rls_admits(org_id)) WITH CHECK (rls_admits(org_id));

-- model_purpose_mappings: platform defaults (org_id NULL) are read by every org (a SELECT-only policy, so an org
-- can neither delete nor update one); writing one needs the platform scope
DROP POLICY IF EXISTS org_scope ON model_purpose_mappings;
CREATE POLICY org_scope ON model_purpose_mappings USING (rls_admits(org_id)) WITH CHECK (rls_admits(org_id));
DROP POLICY IF EXISTS platform_defaults_read ON model_purpose_mappings;
CREATE POLICY platform_defaults_read ON model_purpose_mappings FOR SELECT USING (org_id IS NULL);

-- model_disabled: platform defaults (org_id NULL) are read by every org (a SELECT-only policy, so an org
-- can neither delete nor update one); writing one needs the platform scope
DROP POLICY IF EXISTS org_scope ON model_disabled;
CREATE POLICY org_scope ON model_disabled USING (rls_admits(org_id)) WITH CHECK (rls_admits(org_id));
DROP POLICY IF EXISTS platform_defaults_read ON model_disabled;
CREATE POLICY platform_defaults_read ON model_disabled FOR SELECT USING (org_id IS NULL);

DROP POLICY IF EXISTS org_scope ON model_usage;
CREATE POLICY org_scope ON model_usage USING (rls_admits(org_id)) WITH CHECK (rls_admits(org_id));

DROP POLICY IF EXISTS org_scope ON plugin_import_staging;
CREATE POLICY org_scope ON plugin_import_staging USING (rls_admits(org_id)) WITH CHECK (rls_admits(org_id));

DROP POLICY IF EXISTS org_scope ON catalog_requests;
CREATE POLICY org_scope ON catalog_requests USING (rls_admits(org_id)) WITH CHECK (rls_admits(org_id));

DROP POLICY IF EXISTS org_scope ON catalog_org_grants;
CREATE POLICY org_scope ON catalog_org_grants USING (rls_admits(org_id)) WITH CHECK (rls_admits(org_id));

DROP POLICY IF EXISTS org_scope ON catalog_item_scope_orgs;
CREATE POLICY org_scope ON catalog_item_scope_orgs USING (rls_admits(org_id)) WITH CHECK (rls_admits(org_id));

DROP POLICY IF EXISTS org_scope ON catalog_item_org_switches;
CREATE POLICY org_scope ON catalog_item_org_switches USING (rls_admits(org_id)) WITH CHECK (rls_admits(org_id));

DROP POLICY IF EXISTS org_scope ON component_scope_orgs;
CREATE POLICY org_scope ON component_scope_orgs USING (rls_admits(org_id)) WITH CHECK (rls_admits(org_id));

DROP POLICY IF EXISTS org_scope ON component_org_switches;
CREATE POLICY org_scope ON component_org_switches USING (rls_admits(org_id)) WITH CHECK (rls_admits(org_id));

DROP POLICY IF EXISTS org_scope ON plugin_installs;
CREATE POLICY org_scope ON plugin_installs USING (rls_admits(org_id)) WITH CHECK (rls_admits(org_id));

DROP POLICY IF EXISTS org_scope ON org_notices;
CREATE POLICY org_scope ON org_notices USING (rls_admits(org_id)) WITH CHECK (rls_admits(org_id));

DROP POLICY IF EXISTS org_scope ON plugin_scope_sync_failures;
CREATE POLICY org_scope ON plugin_scope_sync_failures USING (rls_admits(org_id)) WITH CHECK (rls_admits(org_id));

DROP POLICY IF EXISTS org_scope ON extension_client_reports;
CREATE POLICY org_scope ON extension_client_reports USING (rls_admits(org_id)) WITH CHECK (rls_admits(org_id));

DROP POLICY IF EXISTS org_scope ON outbox;
CREATE POLICY org_scope ON outbox USING (rls_admits(org_id)) WITH CHECK (rls_admits(org_id));
