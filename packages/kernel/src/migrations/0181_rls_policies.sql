-- Row level security policies on every kernel table with an org_id column, shipped dark
-- (Postgres RLS spec, docs/superpowers/specs/2026-11-23-postgres-rls-design.md §4, §10; issue #115).
-- The policies admit every row unless a connection set capybara.rls = 'enforce', which only the
-- kernel pool does, under the kernel config db.rls = enforce. Connections that set nothing (the
-- migrator, operators' psql, the startup activation session) are admitted as before.
-- FORCE: the kernel connects as the owner of the schema, which RLS otherwise exempts.

-- The one rule: off unless enforcing; the platform scope sees every org; an org scope sees its
-- own rows. An unscoped enforcing connection has empty settings and matches no row (fail closed).
CREATE OR REPLACE FUNCTION rls_admits(row_org text) RETURNS boolean
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT coalesce(current_setting('capybara.rls', true), '') <> 'enforce'
      OR current_setting('capybara.scope', true) = 'platform'
      OR row_org = current_setting('capybara.org_id', true)
$$;

ALTER TABLE device_retirement_obligations ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_retirement_obligations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_scope ON device_retirement_obligations;
CREATE POLICY org_scope ON device_retirement_obligations USING (rls_admits(org_id)) WITH CHECK (rls_admits(org_id));

ALTER TABLE sandbox_operation_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE sandbox_operation_intents FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_scope ON sandbox_operation_intents;
CREATE POLICY org_scope ON sandbox_operation_intents USING (rls_admits(org_id)) WITH CHECK (rls_admits(org_id));

ALTER TABLE org_data_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_data_keys FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_scope ON org_data_keys;
CREATE POLICY org_scope ON org_data_keys USING (rls_admits(org_id)) WITH CHECK (rls_admits(org_id));

ALTER TABLE platform_sealed_reveals ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_sealed_reveals FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_scope ON platform_sealed_reveals;
CREATE POLICY org_scope ON platform_sealed_reveals USING (rls_admits(org_id)) WITH CHECK (rls_admits(org_id));

ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_scope ON memberships;
CREATE POLICY org_scope ON memberships USING (rls_admits(org_id)) WITH CHECK (rls_admits(org_id));

ALTER TABLE invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE invitations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_scope ON invitations;
CREATE POLICY org_scope ON invitations USING (rls_admits(org_id)) WITH CHECK (rls_admits(org_id));

ALTER TABLE api_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_tokens FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_scope ON api_tokens;
CREATE POLICY org_scope ON api_tokens USING (rls_admits(org_id)) WITH CHECK (rls_admits(org_id));

ALTER TABLE extension_org_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE extension_org_configs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_scope ON extension_org_configs;
CREATE POLICY org_scope ON extension_org_configs USING (rls_admits(org_id)) WITH CHECK (rls_admits(org_id));

ALTER TABLE extension_org_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE extension_org_overrides FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_scope ON extension_org_overrides;
CREATE POLICY org_scope ON extension_org_overrides USING (rls_admits(org_id)) WITH CHECK (rls_admits(org_id));

ALTER TABLE org_tool_switches ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_tool_switches FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_scope ON org_tool_switches;
CREATE POLICY org_scope ON org_tool_switches USING (rls_admits(org_id)) WITH CHECK (rls_admits(org_id));

ALTER TABLE org_network_allowances ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_network_allowances FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_scope ON org_network_allowances;
CREATE POLICY org_scope ON org_network_allowances USING (rls_admits(org_id)) WITH CHECK (rls_admits(org_id));

ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_scope ON audit_events;
CREATE POLICY org_scope ON audit_events USING (rls_admits(org_id)) WITH CHECK (rls_admits(org_id));

ALTER TABLE secrets ENABLE ROW LEVEL SECURITY;
ALTER TABLE secrets FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_scope ON secrets;
CREATE POLICY org_scope ON secrets USING (rls_admits(org_id)) WITH CHECK (rls_admits(org_id));

ALTER TABLE agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE agents FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_scope ON agents;
CREATE POLICY org_scope ON agents USING (rls_admits(org_id)) WITH CHECK (rls_admits(org_id));

ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_scope ON conversations;
CREATE POLICY org_scope ON conversations USING (rls_admits(org_id)) WITH CHECK (rls_admits(org_id));

ALTER TABLE file_previewers ENABLE ROW LEVEL SECURITY;
ALTER TABLE file_previewers FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_scope ON file_previewers;
CREATE POLICY org_scope ON file_previewers USING (rls_admits(org_id)) WITH CHECK (rls_admits(org_id));

ALTER TABLE org_extension_point_defaults ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_extension_point_defaults FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_scope ON org_extension_point_defaults;
CREATE POLICY org_scope ON org_extension_point_defaults USING (rls_admits(org_id)) WITH CHECK (rls_admits(org_id));

ALTER TABLE agent_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_templates FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_scope ON agent_templates;
CREATE POLICY org_scope ON agent_templates USING (rls_admits(org_id)) WITH CHECK (rls_admits(org_id));

ALTER TABLE connectors ENABLE ROW LEVEL SECURITY;
ALTER TABLE connectors FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_scope ON connectors;
CREATE POLICY org_scope ON connectors USING (rls_admits(org_id)) WITH CHECK (rls_admits(org_id));

ALTER TABLE connector_tool_account_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE connector_tool_account_policies FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_scope ON connector_tool_account_policies;
CREATE POLICY org_scope ON connector_tool_account_policies USING (rls_admits(org_id)) WITH CHECK (rls_admits(org_id));

ALTER TABLE tool_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tool_grants FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_scope ON tool_grants;
CREATE POLICY org_scope ON tool_grants USING (rls_admits(org_id)) WITH CHECK (rls_admits(org_id));

ALTER TABLE approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE approvals FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_scope ON approvals;
CREATE POLICY org_scope ON approvals USING (rls_admits(org_id)) WITH CHECK (rls_admits(org_id));

ALTER TABLE permission_call_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE permission_call_grants FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_scope ON permission_call_grants;
CREATE POLICY org_scope ON permission_call_grants USING (rls_admits(org_id)) WITH CHECK (rls_admits(org_id));

ALTER TABLE questions ENABLE ROW LEVEL SECURITY;
ALTER TABLE questions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_scope ON questions;
CREATE POLICY org_scope ON questions USING (rls_admits(org_id)) WITH CHECK (rls_admits(org_id));

ALTER TABLE tool_outputs ENABLE ROW LEVEL SECURITY;
ALTER TABLE tool_outputs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_scope ON tool_outputs;
CREATE POLICY org_scope ON tool_outputs USING (rls_admits(org_id)) WITH CHECK (rls_admits(org_id));

ALTER TABLE channel_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE channel_connections FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_scope ON channel_connections;
CREATE POLICY org_scope ON channel_connections USING (rls_admits(org_id)) WITH CHECK (rls_admits(org_id));

ALTER TABLE org_anonymous_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_anonymous_accounts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_scope ON org_anonymous_accounts;
CREATE POLICY org_scope ON org_anonymous_accounts USING (rls_admits(org_id)) WITH CHECK (rls_admits(org_id));

ALTER TABLE directory_exclusions ENABLE ROW LEVEL SECURITY;
ALTER TABLE directory_exclusions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_scope ON directory_exclusions;
CREATE POLICY org_scope ON directory_exclusions USING (rls_admits(org_id)) WITH CHECK (rls_admits(org_id));

ALTER TABLE attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE attachments FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_scope ON attachments;
CREATE POLICY org_scope ON attachments USING (rls_admits(org_id)) WITH CHECK (rls_admits(org_id));

ALTER TABLE sandboxes ENABLE ROW LEVEL SECURITY;
ALTER TABLE sandboxes FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_scope ON sandboxes;
CREATE POLICY org_scope ON sandboxes USING (rls_admits(org_id)) WITH CHECK (rls_admits(org_id));

ALTER TABLE devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE devices FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_scope ON devices;
CREATE POLICY org_scope ON devices USING (rls_admits(org_id)) WITH CHECK (rls_admits(org_id));

ALTER TABLE device_instances ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_instances FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_scope ON device_instances;
CREATE POLICY org_scope ON device_instances USING (rls_admits(org_id)) WITH CHECK (rls_admits(org_id));

ALTER TABLE device_defaults ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_defaults FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_scope ON device_defaults;
CREATE POLICY org_scope ON device_defaults USING (rls_admits(org_id)) WITH CHECK (rls_admits(org_id));

ALTER TABLE device_machines ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_machines FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_scope ON device_machines;
CREATE POLICY org_scope ON device_machines USING (rls_admits(org_id)) WITH CHECK (rls_admits(org_id));

ALTER TABLE background_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE background_tasks FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_scope ON background_tasks;
CREATE POLICY org_scope ON background_tasks USING (rls_admits(org_id)) WITH CHECK (rls_admits(org_id));

ALTER TABLE scheduled_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE scheduled_tasks FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_scope ON scheduled_tasks;
CREATE POLICY org_scope ON scheduled_tasks USING (rls_admits(org_id)) WITH CHECK (rls_admits(org_id));

ALTER TABLE scheduled_task_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE scheduled_task_runs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_scope ON scheduled_task_runs;
CREATE POLICY org_scope ON scheduled_task_runs USING (rls_admits(org_id)) WITH CHECK (rls_admits(org_id));

ALTER TABLE file_shares ENABLE ROW LEVEL SECURITY;
ALTER TABLE file_shares FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_scope ON file_shares;
CREATE POLICY org_scope ON file_shares USING (rls_admits(org_id)) WITH CHECK (rls_admits(org_id));

ALTER TABLE skills ENABLE ROW LEVEL SECURITY;
ALTER TABLE skills FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_scope ON skills;
CREATE POLICY org_scope ON skills USING (rls_admits(org_id)) WITH CHECK (rls_admits(org_id));

ALTER TABLE skill_change_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE skill_change_requests FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_scope ON skill_change_requests;
CREATE POLICY org_scope ON skill_change_requests USING (rls_admits(org_id)) WITH CHECK (rls_admits(org_id));

ALTER TABLE eval_sets ENABLE ROW LEVEL SECURITY;
ALTER TABLE eval_sets FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_scope ON eval_sets;
CREATE POLICY org_scope ON eval_sets USING (rls_admits(org_id)) WITH CHECK (rls_admits(org_id));

ALTER TABLE eval_cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE eval_cases FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_scope ON eval_cases;
CREATE POLICY org_scope ON eval_cases USING (rls_admits(org_id)) WITH CHECK (rls_admits(org_id));

ALTER TABLE eval_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE eval_runs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_scope ON eval_runs;
CREATE POLICY org_scope ON eval_runs USING (rls_admits(org_id)) WITH CHECK (rls_admits(org_id));

ALTER TABLE eval_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE eval_results FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_scope ON eval_results;
CREATE POLICY org_scope ON eval_results USING (rls_admits(org_id)) WITH CHECK (rls_admits(org_id));

-- model_purpose_mappings: platform defaults (org_id NULL) are read by every org; writing one needs the platform scope
ALTER TABLE model_purpose_mappings ENABLE ROW LEVEL SECURITY;
ALTER TABLE model_purpose_mappings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_scope ON model_purpose_mappings;
CREATE POLICY org_scope ON model_purpose_mappings USING (org_id IS NULL OR rls_admits(org_id)) WITH CHECK (rls_admits(org_id));

-- model_disabled: platform defaults (org_id NULL) are read by every org; writing one needs the platform scope
ALTER TABLE model_disabled ENABLE ROW LEVEL SECURITY;
ALTER TABLE model_disabled FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_scope ON model_disabled;
CREATE POLICY org_scope ON model_disabled USING (org_id IS NULL OR rls_admits(org_id)) WITH CHECK (rls_admits(org_id));

ALTER TABLE model_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE model_usage FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_scope ON model_usage;
CREATE POLICY org_scope ON model_usage USING (rls_admits(org_id)) WITH CHECK (rls_admits(org_id));

ALTER TABLE plugin_import_staging ENABLE ROW LEVEL SECURITY;
ALTER TABLE plugin_import_staging FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_scope ON plugin_import_staging;
CREATE POLICY org_scope ON plugin_import_staging USING (rls_admits(org_id)) WITH CHECK (rls_admits(org_id));

ALTER TABLE catalog_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalog_requests FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_scope ON catalog_requests;
CREATE POLICY org_scope ON catalog_requests USING (rls_admits(org_id)) WITH CHECK (rls_admits(org_id));

ALTER TABLE catalog_org_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalog_org_grants FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_scope ON catalog_org_grants;
CREATE POLICY org_scope ON catalog_org_grants USING (rls_admits(org_id)) WITH CHECK (rls_admits(org_id));

ALTER TABLE catalog_item_scope_orgs ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalog_item_scope_orgs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_scope ON catalog_item_scope_orgs;
CREATE POLICY org_scope ON catalog_item_scope_orgs USING (rls_admits(org_id)) WITH CHECK (rls_admits(org_id));

ALTER TABLE catalog_item_org_switches ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalog_item_org_switches FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_scope ON catalog_item_org_switches;
CREATE POLICY org_scope ON catalog_item_org_switches USING (rls_admits(org_id)) WITH CHECK (rls_admits(org_id));

ALTER TABLE component_scope_orgs ENABLE ROW LEVEL SECURITY;
ALTER TABLE component_scope_orgs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_scope ON component_scope_orgs;
CREATE POLICY org_scope ON component_scope_orgs USING (rls_admits(org_id)) WITH CHECK (rls_admits(org_id));

ALTER TABLE component_org_switches ENABLE ROW LEVEL SECURITY;
ALTER TABLE component_org_switches FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_scope ON component_org_switches;
CREATE POLICY org_scope ON component_org_switches USING (rls_admits(org_id)) WITH CHECK (rls_admits(org_id));

ALTER TABLE plugin_installs ENABLE ROW LEVEL SECURITY;
ALTER TABLE plugin_installs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_scope ON plugin_installs;
CREATE POLICY org_scope ON plugin_installs USING (rls_admits(org_id)) WITH CHECK (rls_admits(org_id));

ALTER TABLE org_notices ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_notices FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_scope ON org_notices;
CREATE POLICY org_scope ON org_notices USING (rls_admits(org_id)) WITH CHECK (rls_admits(org_id));

ALTER TABLE plugin_scope_sync_failures ENABLE ROW LEVEL SECURITY;
ALTER TABLE plugin_scope_sync_failures FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_scope ON plugin_scope_sync_failures;
CREATE POLICY org_scope ON plugin_scope_sync_failures USING (rls_admits(org_id)) WITH CHECK (rls_admits(org_id));

ALTER TABLE extension_client_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE extension_client_reports FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_scope ON extension_client_reports;
CREATE POLICY org_scope ON extension_client_reports USING (rls_admits(org_id)) WITH CHECK (rls_admits(org_id));

ALTER TABLE outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbox FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_scope ON outbox;
CREATE POLICY org_scope ON outbox USING (rls_admits(org_id)) WITH CHECK (rls_admits(org_id));
