-- pulseguard_db baseline schema. Review and apply via migrations in real environments.
CREATE DATABASE IF NOT EXISTS pulseguard_db
  CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
USE pulseguard_db;

CREATE TABLE organizations (
  id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  public_id CHAR(26) NOT NULL UNIQUE,
  name VARCHAR(160) NOT NULL,
  slug VARCHAR(100) NOT NULL UNIQUE,
  status ENUM('active','suspended','deleted') NOT NULL DEFAULT 'active',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    ON UPDATE CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB;

CREATE TABLE users (
  id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  public_id CHAR(26) NOT NULL UNIQUE,
  email VARCHAR(254) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  full_name VARCHAR(160) NOT NULL,
  status ENUM('active','pending','locked','deleted') NOT NULL DEFAULT 'pending',
  email_verified_at DATETIME(3) NULL,
  last_login_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    ON UPDATE CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB;

CREATE TABLE organization_members (
  id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  organization_id BIGINT UNSIGNED NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  role ENUM('owner','admin','engineer','viewer') NOT NULL DEFAULT 'viewer',
  status ENUM('active','invited','suspended') NOT NULL DEFAULT 'invited',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_org_member (organization_id,user_id),
  CONSTRAINT fk_member_org FOREIGN KEY (organization_id) REFERENCES organizations(id),
  CONSTRAINT fk_member_user FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB;

CREATE TABLE refresh_tokens (
  id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  user_id BIGINT UNSIGNED NOT NULL,
  token_hash CHAR(64) NOT NULL UNIQUE,
  family_id CHAR(26) NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  revoked_at DATETIME(3) NULL,
  replaced_by_token_id BIGINT UNSIGNED NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_refresh_user_expiry (user_id,expires_at),
  CONSTRAINT fk_refresh_user FOREIGN KEY (user_id) REFERENCES users(id),
  CONSTRAINT fk_refresh_replaced FOREIGN KEY (replaced_by_token_id) REFERENCES refresh_tokens(id)
) ENGINE=InnoDB;

CREATE TABLE projects (
  id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  public_id CHAR(26) NOT NULL UNIQUE,
  organization_id BIGINT UNSIGNED NOT NULL,
  name VARCHAR(160) NOT NULL,
  environment VARCHAR(80) NOT NULL,
  status ENUM('active','archived') NOT NULL DEFAULT 'active',
  created_by BIGINT UNSIGNED NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_project_org_name_env (organization_id,name,environment),
  KEY idx_project_org_status (organization_id,status),
  CONSTRAINT fk_project_org FOREIGN KEY (organization_id) REFERENCES organizations(id),
  CONSTRAINT fk_project_creator FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB;

CREATE TABLE api_keys (
  id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  organization_id BIGINT UNSIGNED NOT NULL,
  project_id BIGINT UNSIGNED NULL,
  name VARCHAR(120) NOT NULL,
  key_prefix VARCHAR(16) NOT NULL,
  key_hash CHAR(64) NOT NULL UNIQUE,
  scopes JSON NOT NULL,
  last_used_at DATETIME(3) NULL,
  expires_at DATETIME(3) NULL,
  revoked_at DATETIME(3) NULL,
  created_by BIGINT UNSIGNED NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_api_key_org (organization_id,revoked_at),
  CONSTRAINT fk_api_key_org FOREIGN KEY (organization_id) REFERENCES organizations(id),
  CONSTRAINT fk_api_key_project FOREIGN KEY (project_id) REFERENCES projects(id),
  CONSTRAINT fk_api_key_creator FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB;

CREATE TABLE monitors (
  id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  public_id CHAR(26) NOT NULL UNIQUE,
  organization_id BIGINT UNSIGNED NOT NULL,
  project_id BIGINT UNSIGNED NOT NULL,
  name VARCHAR(160) NOT NULL,
  target_url VARCHAR(2048) NOT NULL,
  method ENUM('GET','HEAD','POST') NOT NULL DEFAULT 'GET',
  interval_seconds INT UNSIGNED NOT NULL DEFAULT 60,
  timeout_ms INT UNSIGNED NOT NULL DEFAULT 10000,
  expected_status_min SMALLINT UNSIGNED NOT NULL DEFAULT 200,
  expected_status_max SMALLINT UNSIGNED NOT NULL DEFAULT 299,
  regions JSON NULL,
  request_headers JSON NULL,
  request_body_ref VARCHAR(512) NULL,
  status ENUM('active','paused','disabled') NOT NULL DEFAULT 'active',
  next_run_at DATETIME(3) NULL,
  last_run_at DATETIME(3) NULL,
  created_by BIGINT UNSIGNED NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    ON UPDATE CURRENT_TIMESTAMP(3),
  KEY idx_monitor_due (status,next_run_at),
  KEY idx_monitor_org_project (organization_id,project_id),
  CONSTRAINT fk_monitor_org FOREIGN KEY (organization_id) REFERENCES organizations(id),
  CONSTRAINT fk_monitor_project FOREIGN KEY (project_id) REFERENCES projects(id),
  CONSTRAINT fk_monitor_creator FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB;

CREATE TABLE monitor_check_results (
  id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  organization_id BIGINT UNSIGNED NOT NULL,
  monitor_id BIGINT UNSIGNED NOT NULL,
  check_id CHAR(26) NOT NULL UNIQUE,
  region VARCHAR(64) NOT NULL,
  status ENUM('success','failure','timeout','blocked') NOT NULL,
  http_status SMALLINT UNSIGNED NULL,
  latency_ms INT UNSIGNED NULL,
  dns_ms INT UNSIGNED NULL,
  connect_ms INT UNSIGNED NULL,
  tls_ms INT UNSIGNED NULL,
  error_code VARCHAR(80) NULL,
  checked_at DATETIME(3) NOT NULL,
  KEY idx_check_monitor_time (monitor_id,checked_at),
  KEY idx_check_org_time (organization_id,checked_at),
  CONSTRAINT fk_check_org FOREIGN KEY (organization_id) REFERENCES organizations(id),
  CONSTRAINT fk_check_monitor FOREIGN KEY (monitor_id) REFERENCES monitors(id)
) ENGINE=InnoDB;

CREATE TABLE alert_rules (
  id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  public_id CHAR(26) NOT NULL UNIQUE,
  organization_id BIGINT UNSIGNED NOT NULL,
  project_id BIGINT UNSIGNED NULL,
  monitor_id BIGINT UNSIGNED NULL,
  name VARCHAR(160) NOT NULL,
  metric ENUM('availability','latency_ms','error_rate') NOT NULL,
  operator ENUM('gt','gte','lt','lte') NOT NULL,
  threshold DECIMAL(14,4) NOT NULL,
  evaluation_window_seconds INT UNSIGNED NOT NULL DEFAULT 300,
  consecutive_periods INT UNSIGNED NOT NULL DEFAULT 2,
  severity ENUM('critical','high','medium','low') NOT NULL DEFAULT 'high',
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_by BIGINT UNSIGNED NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    ON UPDATE CURRENT_TIMESTAMP(3),
  KEY idx_alert_rule_org_enabled (organization_id,enabled),
  CONSTRAINT fk_alert_org FOREIGN KEY (organization_id) REFERENCES organizations(id),
  CONSTRAINT fk_alert_project FOREIGN KEY (project_id) REFERENCES projects(id),
  CONSTRAINT fk_alert_monitor FOREIGN KEY (monitor_id) REFERENCES monitors(id),
  CONSTRAINT fk_alert_creator FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB;

CREATE TABLE incidents (
  id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  public_id CHAR(26) NOT NULL UNIQUE,
  organization_id BIGINT UNSIGNED NOT NULL,
  project_id BIGINT UNSIGNED NOT NULL,
  monitor_id BIGINT UNSIGNED NULL,
  alert_rule_id BIGINT UNSIGNED NULL,
  dedupe_key CHAR(64) NOT NULL,
  title VARCHAR(255) NOT NULL,
  severity ENUM('critical','high','medium','low') NOT NULL,
  status ENUM('open','acknowledged','investigating','resolved') NOT NULL DEFAULT 'open',
  started_at DATETIME(3) NOT NULL,
  acknowledged_at DATETIME(3) NULL,
  acknowledged_by BIGINT UNSIGNED NULL,
  resolved_at DATETIME(3) NULL,
  resolved_by BIGINT UNSIGNED NULL,
  last_triggered_at DATETIME(3) NOT NULL,
  occurrence_count INT UNSIGNED NOT NULL DEFAULT 1,
  resolution_note TEXT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_incident_dedupe_active (organization_id,dedupe_key,status),
  KEY idx_incident_org_status_time (organization_id,status,last_triggered_at),
  KEY idx_incident_project_time (project_id,last_triggered_at),
  CONSTRAINT fk_incident_org FOREIGN KEY (organization_id) REFERENCES organizations(id),
  CONSTRAINT fk_incident_project FOREIGN KEY (project_id) REFERENCES projects(id),
  CONSTRAINT fk_incident_monitor FOREIGN KEY (monitor_id) REFERENCES monitors(id),
  CONSTRAINT fk_incident_rule FOREIGN KEY (alert_rule_id) REFERENCES alert_rules(id),
  CONSTRAINT fk_incident_ack_user FOREIGN KEY (acknowledged_by) REFERENCES users(id),
  CONSTRAINT fk_incident_resolve_user FOREIGN KEY (resolved_by) REFERENCES users(id)
) ENGINE=InnoDB;

CREATE TABLE incident_events (
  id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  incident_id BIGINT UNSIGNED NOT NULL,
  organization_id BIGINT UNSIGNED NOT NULL,
  actor_user_id BIGINT UNSIGNED NULL,
  event_type VARCHAR(80) NOT NULL,
  from_status VARCHAR(32) NULL,
  to_status VARCHAR(32) NULL,
  message TEXT NULL,
  metadata JSON NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_incident_event_time (incident_id,created_at),
  CONSTRAINT fk_inc_event_incident FOREIGN KEY (incident_id) REFERENCES incidents(id),
  CONSTRAINT fk_inc_event_org FOREIGN KEY (organization_id) REFERENCES organizations(id),
  CONSTRAINT fk_inc_event_actor FOREIGN KEY (actor_user_id) REFERENCES users(id)
) ENGINE=InnoDB;

CREATE TABLE notification_channels (
  id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  organization_id BIGINT UNSIGNED NOT NULL,
  name VARCHAR(120) NOT NULL,
  channel_type ENUM('email','webhook','slack') NOT NULL,
  config_encrypted JSON NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    ON UPDATE CURRENT_TIMESTAMP(3),
  KEY idx_channel_org_enabled (organization_id,enabled),
  CONSTRAINT fk_channel_org FOREIGN KEY (organization_id) REFERENCES organizations(id)
) ENGINE=InnoDB;

CREATE TABLE notification_deliveries (
  id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  organization_id BIGINT UNSIGNED NOT NULL,
  incident_id BIGINT UNSIGNED NOT NULL,
  channel_id BIGINT UNSIGNED NOT NULL,
  dedupe_key CHAR(64) NOT NULL,
  status ENUM('queued','sending','sent','failed','cancelled') NOT NULL DEFAULT 'queued',
  attempts INT UNSIGNED NOT NULL DEFAULT 0,
  next_attempt_at DATETIME(3) NULL,
  last_error VARCHAR(1000) NULL,
  sent_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_notification_dedupe (dedupe_key),
  KEY idx_notification_pending (status,next_attempt_at),
  CONSTRAINT fk_delivery_org FOREIGN KEY (organization_id) REFERENCES organizations(id),
  CONSTRAINT fk_delivery_incident FOREIGN KEY (incident_id) REFERENCES incidents(id),
  CONSTRAINT fk_delivery_channel FOREIGN KEY (channel_id) REFERENCES notification_channels(id)
) ENGINE=InnoDB;

CREATE TABLE telemetry_events (
  id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  organization_id BIGINT UNSIGNED NOT NULL,
  project_id BIGINT UNSIGNED NOT NULL,
  api_key_id BIGINT UNSIGNED NULL,
  event_id CHAR(26) NOT NULL,
  service_name VARCHAR(160) NOT NULL,
  route_template VARCHAR(255) NULL,
  http_method VARCHAR(12) NULL,
  status_code SMALLINT UNSIGNED NULL,
  duration_ms INT UNSIGNED NULL,
  event_timestamp DATETIME(3) NOT NULL,
  attributes JSON NULL,
  received_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_telemetry_org_event (organization_id,event_id),
  KEY idx_telemetry_project_time (project_id,event_timestamp),
  KEY idx_telemetry_service_route_time (organization_id,service_name,route_template,event_timestamp),
  CONSTRAINT fk_telemetry_org FOREIGN KEY (organization_id) REFERENCES organizations(id),
  CONSTRAINT fk_telemetry_project FOREIGN KEY (project_id) REFERENCES projects(id),
  CONSTRAINT fk_telemetry_api_key FOREIGN KEY (api_key_id) REFERENCES api_keys(id)
) ENGINE=InnoDB;

CREATE TABLE application_logs (
  id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  organization_id BIGINT UNSIGNED NOT NULL,
  project_id BIGINT UNSIGNED NOT NULL,
  api_key_id BIGINT UNSIGNED NULL,
  log_event_id CHAR(26) NOT NULL,
  service_name VARCHAR(160) NOT NULL,
  severity ENUM('trace','debug','info','warn','error','fatal') NOT NULL,
  message TEXT NOT NULL,
  trace_id CHAR(32) NULL,
  span_id CHAR(16) NULL,
  log_timestamp DATETIME(3) NOT NULL,
  attributes JSON NULL,
  received_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_log_org_event (organization_id,log_event_id),
  KEY idx_log_project_time (project_id,log_timestamp),
  KEY idx_log_org_severity_time (organization_id,severity,log_timestamp),
  KEY idx_log_trace (trace_id),
  CONSTRAINT fk_log_org FOREIGN KEY (organization_id) REFERENCES organizations(id),
  CONSTRAINT fk_log_project FOREIGN KEY (project_id) REFERENCES projects(id),
  CONSTRAINT fk_log_api_key FOREIGN KEY (api_key_id) REFERENCES api_keys(id)
) ENGINE=InnoDB;

CREATE TABLE ai_analyses (
  id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  public_id CHAR(26) NOT NULL UNIQUE,
  organization_id BIGINT UNSIGNED NOT NULL,
  incident_id BIGINT UNSIGNED NOT NULL,
  status ENUM('queued','processing','completed','failed') NOT NULL DEFAULT 'queued',
  provider VARCHAR(80) NOT NULL,
  model VARCHAR(120) NOT NULL,
  prompt_version VARCHAR(40) NOT NULL,
  summary TEXT NULL,
  hypotheses JSON NULL,
  evidence_refs JSON NULL,
  confidence DECIMAL(5,4) NULL,
  input_tokens INT UNSIGNED NULL,
  output_tokens INT UNSIGNED NULL,
  error_code VARCHAR(80) NULL,
  started_at DATETIME(3) NULL,
  completed_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_ai_incident_time (incident_id,created_at),
  KEY idx_ai_org_status (organization_id,status),
  CONSTRAINT fk_ai_org FOREIGN KEY (organization_id) REFERENCES organizations(id),
  CONSTRAINT fk_ai_incident FOREIGN KEY (incident_id) REFERENCES incidents(id)
) ENGINE=InnoDB;

CREATE TABLE audit_logs (
  id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  organization_id BIGINT UNSIGNED NOT NULL,
  actor_user_id BIGINT UNSIGNED NULL,
  action VARCHAR(120) NOT NULL,
  resource_type VARCHAR(80) NOT NULL,
  resource_id VARCHAR(64) NULL,
  ip_address VARBINARY(16) NULL,
  user_agent VARCHAR(512) NULL,
  metadata JSON NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_audit_org_time (organization_id,created_at),
  KEY idx_audit_resource (resource_type,resource_id),
  CONSTRAINT fk_audit_org FOREIGN KEY (organization_id) REFERENCES organizations(id),
  CONSTRAINT fk_audit_actor FOREIGN KEY (actor_user_id) REFERENCES users(id)
) ENGINE=InnoDB;

CREATE TABLE outbox_events (
  id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  event_id CHAR(26) NOT NULL UNIQUE,
  aggregate_type VARCHAR(80) NOT NULL,
  aggregate_id VARCHAR(64) NOT NULL,
  event_type VARCHAR(120) NOT NULL,
  payload JSON NOT NULL,
  status ENUM('pending','publishing','published','failed') NOT NULL DEFAULT 'pending',
  attempts INT UNSIGNED NOT NULL DEFAULT 0,
  available_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  published_at DATETIME(3) NULL,
  last_error VARCHAR(1000) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_outbox_dispatch (status,available_at,id)
) ENGINE=InnoDB;
