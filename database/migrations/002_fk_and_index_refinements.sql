-- Refinements on top of the owner's baseline schema (001).
-- Kept in a separate migration so pulseguard_schema.sql stays the untouched
-- source of truth. Two goals:
--   1. Define explicit ON DELETE behavior for ownership foreign keys. The
--      baseline FKs default to RESTRICT, which blocks deleting an organization,
--      user, monitor, etc. while children exist. Tenant-owned data should be
--      removed with its owner (CASCADE); optional attribution links should not
--      block deletion (SET NULL).
--   2. Add a few indexes that back common lookups.
--
-- Each FK is dropped and re-created with the desired ON DELETE rule. Adding an
-- index that already exists is guarded with a uniqueness note in comments.

-- @UP

-- organization_members: remove membership when org or user is deleted.
ALTER TABLE organization_members DROP FOREIGN KEY fk_member_org;
ALTER TABLE organization_members
  ADD CONSTRAINT fk_member_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE;
ALTER TABLE organization_members DROP FOREIGN KEY fk_member_user;
ALTER TABLE organization_members
  ADD CONSTRAINT fk_member_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

-- refresh_tokens: tokens belong to a user; drop with the user. The self
-- reference (replaced_by_token_id) becomes NULL when the predecessor is gone.
ALTER TABLE refresh_tokens DROP FOREIGN KEY fk_refresh_user;
ALTER TABLE refresh_tokens
  ADD CONSTRAINT fk_refresh_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE refresh_tokens DROP FOREIGN KEY fk_refresh_replaced;
ALTER TABLE refresh_tokens
  ADD CONSTRAINT fk_refresh_replaced FOREIGN KEY (replaced_by_token_id) REFERENCES refresh_tokens(id) ON DELETE SET NULL;

-- projects: belong to an org; creator attribution is optional.
ALTER TABLE projects DROP FOREIGN KEY fk_project_org;
ALTER TABLE projects
  ADD CONSTRAINT fk_project_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE;
ALTER TABLE projects DROP FOREIGN KEY fk_project_creator;
ALTER TABLE projects
  ADD CONSTRAINT fk_project_creator FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;

-- api_keys: belong to an org; project link and creator attribution optional.
ALTER TABLE api_keys DROP FOREIGN KEY fk_api_key_org;
ALTER TABLE api_keys
  ADD CONSTRAINT fk_api_key_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE;
ALTER TABLE api_keys DROP FOREIGN KEY fk_api_key_project;
ALTER TABLE api_keys
  ADD CONSTRAINT fk_api_key_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL;
ALTER TABLE api_keys DROP FOREIGN KEY fk_api_key_creator;
ALTER TABLE api_keys
  ADD CONSTRAINT fk_api_key_creator FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;

-- monitors: cascade with org/project; creator attribution optional.
ALTER TABLE monitors DROP FOREIGN KEY fk_monitor_org;
ALTER TABLE monitors
  ADD CONSTRAINT fk_monitor_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE;
ALTER TABLE monitors DROP FOREIGN KEY fk_monitor_project;
ALTER TABLE monitors
  ADD CONSTRAINT fk_monitor_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;
ALTER TABLE monitors DROP FOREIGN KEY fk_monitor_creator;
ALTER TABLE monitors
  ADD CONSTRAINT fk_monitor_creator FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;

-- monitor_check_results: high-volume child of monitor/org; cascade on delete.
ALTER TABLE monitor_check_results DROP FOREIGN KEY fk_check_org;
ALTER TABLE monitor_check_results
  ADD CONSTRAINT fk_check_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE;
ALTER TABLE monitor_check_results DROP FOREIGN KEY fk_check_monitor;
ALTER TABLE monitor_check_results
  ADD CONSTRAINT fk_check_monitor FOREIGN KEY (monitor_id) REFERENCES monitors(id) ON DELETE CASCADE;

-- alert_rules: cascade with org; project/monitor links optional; creator optional.
ALTER TABLE alert_rules DROP FOREIGN KEY fk_alert_org;
ALTER TABLE alert_rules
  ADD CONSTRAINT fk_alert_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE;
ALTER TABLE alert_rules DROP FOREIGN KEY fk_alert_project;
ALTER TABLE alert_rules
  ADD CONSTRAINT fk_alert_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;
ALTER TABLE alert_rules DROP FOREIGN KEY fk_alert_monitor;
ALTER TABLE alert_rules
  ADD CONSTRAINT fk_alert_monitor FOREIGN KEY (monitor_id) REFERENCES monitors(id) ON DELETE CASCADE;
ALTER TABLE alert_rules DROP FOREIGN KEY fk_alert_creator;
ALTER TABLE alert_rules
  ADD CONSTRAINT fk_alert_creator FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;

-- incidents: cascade with org/project; monitor/rule links optional; ack/resolve
-- user attribution optional.
ALTER TABLE incidents DROP FOREIGN KEY fk_incident_org;
ALTER TABLE incidents
  ADD CONSTRAINT fk_incident_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE;
ALTER TABLE incidents DROP FOREIGN KEY fk_incident_project;
ALTER TABLE incidents
  ADD CONSTRAINT fk_incident_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;
ALTER TABLE incidents DROP FOREIGN KEY fk_incident_monitor;
ALTER TABLE incidents
  ADD CONSTRAINT fk_incident_monitor FOREIGN KEY (monitor_id) REFERENCES monitors(id) ON DELETE SET NULL;
ALTER TABLE incidents DROP FOREIGN KEY fk_incident_rule;
ALTER TABLE incidents
  ADD CONSTRAINT fk_incident_rule FOREIGN KEY (alert_rule_id) REFERENCES alert_rules(id) ON DELETE SET NULL;
ALTER TABLE incidents DROP FOREIGN KEY fk_incident_ack_user;
ALTER TABLE incidents
  ADD CONSTRAINT fk_incident_ack_user FOREIGN KEY (acknowledged_by) REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE incidents DROP FOREIGN KEY fk_incident_resolve_user;
ALTER TABLE incidents
  ADD CONSTRAINT fk_incident_resolve_user FOREIGN KEY (resolved_by) REFERENCES users(id) ON DELETE SET NULL;

-- incident_events: cascade with incident/org; actor optional.
ALTER TABLE incident_events DROP FOREIGN KEY fk_inc_event_incident;
ALTER TABLE incident_events
  ADD CONSTRAINT fk_inc_event_incident FOREIGN KEY (incident_id) REFERENCES incidents(id) ON DELETE CASCADE;
ALTER TABLE incident_events DROP FOREIGN KEY fk_inc_event_org;
ALTER TABLE incident_events
  ADD CONSTRAINT fk_inc_event_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE;
ALTER TABLE incident_events DROP FOREIGN KEY fk_inc_event_actor;
ALTER TABLE incident_events
  ADD CONSTRAINT fk_inc_event_actor FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE SET NULL;

-- notification_channels: cascade with org.
ALTER TABLE notification_channels DROP FOREIGN KEY fk_channel_org;
ALTER TABLE notification_channels
  ADD CONSTRAINT fk_channel_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE;

-- notification_deliveries: cascade with org/incident/channel.
ALTER TABLE notification_deliveries DROP FOREIGN KEY fk_delivery_org;
ALTER TABLE notification_deliveries
  ADD CONSTRAINT fk_delivery_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE;
ALTER TABLE notification_deliveries DROP FOREIGN KEY fk_delivery_incident;
ALTER TABLE notification_deliveries
  ADD CONSTRAINT fk_delivery_incident FOREIGN KEY (incident_id) REFERENCES incidents(id) ON DELETE CASCADE;
ALTER TABLE notification_deliveries DROP FOREIGN KEY fk_delivery_channel;
ALTER TABLE notification_deliveries
  ADD CONSTRAINT fk_delivery_channel FOREIGN KEY (channel_id) REFERENCES notification_channels(id) ON DELETE CASCADE;

-- telemetry_events: cascade with org/project; api_key link optional.
ALTER TABLE telemetry_events DROP FOREIGN KEY fk_telemetry_org;
ALTER TABLE telemetry_events
  ADD CONSTRAINT fk_telemetry_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE;
ALTER TABLE telemetry_events DROP FOREIGN KEY fk_telemetry_project;
ALTER TABLE telemetry_events
  ADD CONSTRAINT fk_telemetry_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;
ALTER TABLE telemetry_events DROP FOREIGN KEY fk_telemetry_api_key;
ALTER TABLE telemetry_events
  ADD CONSTRAINT fk_telemetry_api_key FOREIGN KEY (api_key_id) REFERENCES api_keys(id) ON DELETE SET NULL;

-- application_logs: cascade with org/project; api_key link optional.
ALTER TABLE application_logs DROP FOREIGN KEY fk_log_org;
ALTER TABLE application_logs
  ADD CONSTRAINT fk_log_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE;
ALTER TABLE application_logs DROP FOREIGN KEY fk_log_project;
ALTER TABLE application_logs
  ADD CONSTRAINT fk_log_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;
ALTER TABLE application_logs DROP FOREIGN KEY fk_log_api_key;
ALTER TABLE application_logs
  ADD CONSTRAINT fk_log_api_key FOREIGN KEY (api_key_id) REFERENCES api_keys(id) ON DELETE SET NULL;

-- ai_analyses: cascade with org/incident.
ALTER TABLE ai_analyses DROP FOREIGN KEY fk_ai_org;
ALTER TABLE ai_analyses
  ADD CONSTRAINT fk_ai_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE;
ALTER TABLE ai_analyses DROP FOREIGN KEY fk_ai_incident;
ALTER TABLE ai_analyses
  ADD CONSTRAINT fk_ai_incident FOREIGN KEY (incident_id) REFERENCES incidents(id) ON DELETE CASCADE;

-- audit_logs: cascade with org; actor optional. Audit rows are retained even if
-- the actor is removed, so actor is SET NULL.
ALTER TABLE audit_logs DROP FOREIGN KEY fk_audit_org;
ALTER TABLE audit_logs
  ADD CONSTRAINT fk_audit_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE;
ALTER TABLE audit_logs DROP FOREIGN KEY fk_audit_actor;
ALTER TABLE audit_logs
  ADD CONSTRAINT fk_audit_actor FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE SET NULL;

-- Note: no extra indexes on monitor_id are added here. Each foreign key column
-- (incidents.monitor_id, alert_rules.monitor_id, etc.) is already backed by an
-- index that MySQL maintains automatically for the constraint, so per-monitor
-- lookups are covered without a redundant secondary index.

-- @DOWN

-- Restore baseline FKs (default RESTRICT / no ON DELETE clause).
ALTER TABLE audit_logs DROP FOREIGN KEY fk_audit_actor;
ALTER TABLE audit_logs
  ADD CONSTRAINT fk_audit_actor FOREIGN KEY (actor_user_id) REFERENCES users(id);
ALTER TABLE audit_logs DROP FOREIGN KEY fk_audit_org;
ALTER TABLE audit_logs
  ADD CONSTRAINT fk_audit_org FOREIGN KEY (organization_id) REFERENCES organizations(id);

ALTER TABLE ai_analyses DROP FOREIGN KEY fk_ai_incident;
ALTER TABLE ai_analyses
  ADD CONSTRAINT fk_ai_incident FOREIGN KEY (incident_id) REFERENCES incidents(id);
ALTER TABLE ai_analyses DROP FOREIGN KEY fk_ai_org;
ALTER TABLE ai_analyses
  ADD CONSTRAINT fk_ai_org FOREIGN KEY (organization_id) REFERENCES organizations(id);

ALTER TABLE application_logs DROP FOREIGN KEY fk_log_api_key;
ALTER TABLE application_logs
  ADD CONSTRAINT fk_log_api_key FOREIGN KEY (api_key_id) REFERENCES api_keys(id);
ALTER TABLE application_logs DROP FOREIGN KEY fk_log_project;
ALTER TABLE application_logs
  ADD CONSTRAINT fk_log_project FOREIGN KEY (project_id) REFERENCES projects(id);
ALTER TABLE application_logs DROP FOREIGN KEY fk_log_org;
ALTER TABLE application_logs
  ADD CONSTRAINT fk_log_org FOREIGN KEY (organization_id) REFERENCES organizations(id);

ALTER TABLE telemetry_events DROP FOREIGN KEY fk_telemetry_api_key;
ALTER TABLE telemetry_events
  ADD CONSTRAINT fk_telemetry_api_key FOREIGN KEY (api_key_id) REFERENCES api_keys(id);
ALTER TABLE telemetry_events DROP FOREIGN KEY fk_telemetry_project;
ALTER TABLE telemetry_events
  ADD CONSTRAINT fk_telemetry_project FOREIGN KEY (project_id) REFERENCES projects(id);
ALTER TABLE telemetry_events DROP FOREIGN KEY fk_telemetry_org;
ALTER TABLE telemetry_events
  ADD CONSTRAINT fk_telemetry_org FOREIGN KEY (organization_id) REFERENCES organizations(id);

ALTER TABLE notification_deliveries DROP FOREIGN KEY fk_delivery_channel;
ALTER TABLE notification_deliveries
  ADD CONSTRAINT fk_delivery_channel FOREIGN KEY (channel_id) REFERENCES notification_channels(id);
ALTER TABLE notification_deliveries DROP FOREIGN KEY fk_delivery_incident;
ALTER TABLE notification_deliveries
  ADD CONSTRAINT fk_delivery_incident FOREIGN KEY (incident_id) REFERENCES incidents(id);
ALTER TABLE notification_deliveries DROP FOREIGN KEY fk_delivery_org;
ALTER TABLE notification_deliveries
  ADD CONSTRAINT fk_delivery_org FOREIGN KEY (organization_id) REFERENCES organizations(id);

ALTER TABLE notification_channels DROP FOREIGN KEY fk_channel_org;
ALTER TABLE notification_channels
  ADD CONSTRAINT fk_channel_org FOREIGN KEY (organization_id) REFERENCES organizations(id);

ALTER TABLE incident_events DROP FOREIGN KEY fk_inc_event_actor;
ALTER TABLE incident_events
  ADD CONSTRAINT fk_inc_event_actor FOREIGN KEY (actor_user_id) REFERENCES users(id);
ALTER TABLE incident_events DROP FOREIGN KEY fk_inc_event_org;
ALTER TABLE incident_events
  ADD CONSTRAINT fk_inc_event_org FOREIGN KEY (organization_id) REFERENCES organizations(id);
ALTER TABLE incident_events DROP FOREIGN KEY fk_inc_event_incident;
ALTER TABLE incident_events
  ADD CONSTRAINT fk_inc_event_incident FOREIGN KEY (incident_id) REFERENCES incidents(id);

ALTER TABLE incidents DROP FOREIGN KEY fk_incident_resolve_user;
ALTER TABLE incidents
  ADD CONSTRAINT fk_incident_resolve_user FOREIGN KEY (resolved_by) REFERENCES users(id);
ALTER TABLE incidents DROP FOREIGN KEY fk_incident_ack_user;
ALTER TABLE incidents
  ADD CONSTRAINT fk_incident_ack_user FOREIGN KEY (acknowledged_by) REFERENCES users(id);
ALTER TABLE incidents DROP FOREIGN KEY fk_incident_rule;
ALTER TABLE incidents
  ADD CONSTRAINT fk_incident_rule FOREIGN KEY (alert_rule_id) REFERENCES alert_rules(id);
ALTER TABLE incidents DROP FOREIGN KEY fk_incident_monitor;
ALTER TABLE incidents
  ADD CONSTRAINT fk_incident_monitor FOREIGN KEY (monitor_id) REFERENCES monitors(id);
ALTER TABLE incidents DROP FOREIGN KEY fk_incident_project;
ALTER TABLE incidents
  ADD CONSTRAINT fk_incident_project FOREIGN KEY (project_id) REFERENCES projects(id);
ALTER TABLE incidents DROP FOREIGN KEY fk_incident_org;
ALTER TABLE incidents
  ADD CONSTRAINT fk_incident_org FOREIGN KEY (organization_id) REFERENCES organizations(id);

ALTER TABLE alert_rules DROP FOREIGN KEY fk_alert_creator;
ALTER TABLE alert_rules
  ADD CONSTRAINT fk_alert_creator FOREIGN KEY (created_by) REFERENCES users(id);
ALTER TABLE alert_rules DROP FOREIGN KEY fk_alert_monitor;
ALTER TABLE alert_rules
  ADD CONSTRAINT fk_alert_monitor FOREIGN KEY (monitor_id) REFERENCES monitors(id);
ALTER TABLE alert_rules DROP FOREIGN KEY fk_alert_project;
ALTER TABLE alert_rules
  ADD CONSTRAINT fk_alert_project FOREIGN KEY (project_id) REFERENCES projects(id);
ALTER TABLE alert_rules DROP FOREIGN KEY fk_alert_org;
ALTER TABLE alert_rules
  ADD CONSTRAINT fk_alert_org FOREIGN KEY (organization_id) REFERENCES organizations(id);

ALTER TABLE monitor_check_results DROP FOREIGN KEY fk_check_monitor;
ALTER TABLE monitor_check_results
  ADD CONSTRAINT fk_check_monitor FOREIGN KEY (monitor_id) REFERENCES monitors(id);
ALTER TABLE monitor_check_results DROP FOREIGN KEY fk_check_org;
ALTER TABLE monitor_check_results
  ADD CONSTRAINT fk_check_org FOREIGN KEY (organization_id) REFERENCES organizations(id);

ALTER TABLE monitors DROP FOREIGN KEY fk_monitor_creator;
ALTER TABLE monitors
  ADD CONSTRAINT fk_monitor_creator FOREIGN KEY (created_by) REFERENCES users(id);
ALTER TABLE monitors DROP FOREIGN KEY fk_monitor_project;
ALTER TABLE monitors
  ADD CONSTRAINT fk_monitor_project FOREIGN KEY (project_id) REFERENCES projects(id);
ALTER TABLE monitors DROP FOREIGN KEY fk_monitor_org;
ALTER TABLE monitors
  ADD CONSTRAINT fk_monitor_org FOREIGN KEY (organization_id) REFERENCES organizations(id);

ALTER TABLE api_keys DROP FOREIGN KEY fk_api_key_creator;
ALTER TABLE api_keys
  ADD CONSTRAINT fk_api_key_creator FOREIGN KEY (created_by) REFERENCES users(id);
ALTER TABLE api_keys DROP FOREIGN KEY fk_api_key_project;
ALTER TABLE api_keys
  ADD CONSTRAINT fk_api_key_project FOREIGN KEY (project_id) REFERENCES projects(id);
ALTER TABLE api_keys DROP FOREIGN KEY fk_api_key_org;
ALTER TABLE api_keys
  ADD CONSTRAINT fk_api_key_org FOREIGN KEY (organization_id) REFERENCES organizations(id);

ALTER TABLE projects DROP FOREIGN KEY fk_project_creator;
ALTER TABLE projects
  ADD CONSTRAINT fk_project_creator FOREIGN KEY (created_by) REFERENCES users(id);
ALTER TABLE projects DROP FOREIGN KEY fk_project_org;
ALTER TABLE projects
  ADD CONSTRAINT fk_project_org FOREIGN KEY (organization_id) REFERENCES organizations(id);

ALTER TABLE refresh_tokens DROP FOREIGN KEY fk_refresh_replaced;
ALTER TABLE refresh_tokens
  ADD CONSTRAINT fk_refresh_replaced FOREIGN KEY (replaced_by_token_id) REFERENCES refresh_tokens(id);
ALTER TABLE refresh_tokens DROP FOREIGN KEY fk_refresh_user;
ALTER TABLE refresh_tokens
  ADD CONSTRAINT fk_refresh_user FOREIGN KEY (user_id) REFERENCES users(id);

ALTER TABLE organization_members DROP FOREIGN KEY fk_member_user;
ALTER TABLE organization_members
  ADD CONSTRAINT fk_member_user FOREIGN KEY (user_id) REFERENCES users(id);
ALTER TABLE organization_members DROP FOREIGN KEY fk_member_org;
ALTER TABLE organization_members
  ADD CONSTRAINT fk_member_org FOREIGN KEY (organization_id) REFERENCES organizations(id);
