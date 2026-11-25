'use strict';

const path = require('path');
const dotenv = require('dotenv');
const { z } = require('zod');

// Load .env from the repository root. This is a no-op if the file does not exist.
dotenv.config({ path: path.resolve(__dirname, '../../../../.env') });

const booleanFromString = z
  .enum(['true', 'false'])
  .transform((value) => value === 'true');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().max(65535).default(3000),

  // Comma-separated list of allowed CORS origins. Empty means "no cross-origin allowed".
  CORS_ORIGINS: z.string().default(''),

  // Baseline rate limiting for the API.
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(100),

  LOG_LEVEL: z
    .enum(['error', 'warn', 'info', 'http', 'verbose', 'debug', 'silly'])
    .default('info'),

  // Authentication. JWT_SECRET must be strong in production (validated below).
  JWT_SECRET: z.string().min(1).default('dev-insecure-jwt-secret-change-me'),
  // Access-token lifetime in seconds (default 15 minutes).
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  // Refresh-token lifetime in seconds (default 30 days).
  REFRESH_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(2_592_000),
  // bcrypt cost factor. 10-12 is a reasonable range for interactive logins.
  BCRYPT_ROUNDS: z.coerce.number().int().min(4).max(15).default(12),
  // Issuer/audience claims for issued JWTs.
  JWT_ISSUER: z.string().default('pulseguard'),
  JWT_AUDIENCE: z.string().default('pulseguard-api'),

  // Monitor limits (enforced by the monitors module).
  MONITOR_MIN_INTERVAL_SECONDS: z.coerce.number().int().positive().default(30),
  MONITOR_MAX_INTERVAL_SECONDS: z.coerce.number().int().positive().default(86_400),
  MONITOR_MIN_TIMEOUT_MS: z.coerce.number().int().positive().default(1_000),
  MONITOR_MAX_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
  MONITOR_MAX_PER_PROJECT: z.coerce.number().int().positive().default(50),
  // Set to 'true' only in test/dev to allow monitors targeting localhost/private
  // hosts. MUST remain false in production (SSRF protection).
  MONITOR_ALLOW_PRIVATE_TARGETS: booleanFromString.default('false'),

  // Database configuration (consumed in Phase 2). Declared here so env validation
  // fails fast if partially configured. Password is intentionally allowed to be empty
  // for local development only; production must supply a real secret.
  DB_HOST: z.string().default('localhost'),
  DB_PORT: z.coerce.number().int().positive().max(65535).default(3306),
  DB_USER: z.string().default('root'),
  DB_PASSWORD: z.string().default(''),
  DB_NAME: z.string().default('pulseguard_db'),

  // Redis configuration.
  REDIS_HOST: z.string().default('localhost'),
  REDIS_PORT: z.coerce.number().int().positive().max(65535).default(6379),

  // Background queue (BullMQ). When false, enqueue calls are no-ops so the API
  // can run without Redis (useful in tests/dev). The worker requires this true.
  QUEUE_ENABLED: booleanFromString.default('false'),
  CHECK_QUEUE_NAME: z.string().default('monitor-checks'),
  // Bounded retry policy for transient check-job failures.
  CHECK_JOB_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
  CHECK_JOB_BACKOFF_MS: z.coerce.number().int().positive().default(5_000),
  // Worker concurrency and HTTP response-size cap.
  WORKER_CONCURRENCY: z.coerce.number().int().positive().max(100).default(10),
  CHECK_MAX_RESPONSE_BYTES: z.coerce.number().int().positive().default(1_048_576),
  CHECK_MAX_REDIRECTS: z.coerce.number().int().min(0).max(10).default(3),

  // Incident detection thresholds.
  // Consecutive failing check results required to open an incident.
  INCIDENT_FAILURE_THRESHOLD: z.coerce.number().int().min(1).max(20).default(3),
  // Consecutive successful check results required to resolve an open incident.
  INCIDENT_RECOVERY_THRESHOLD: z.coerce.number().int().min(1).max(20).default(2),

  // Notifications.
  NOTIFICATIONS_ENABLED: booleanFromString.default('false'),
  // 'log' writes intent to the log without sending; 'smtp' uses nodemailer.
  EMAIL_PROVIDER: z.enum(['log', 'smtp']).default('log'),
  EMAIL_FROM: z.string().default('pulseguard@localhost'),
  SMTP_HOST: z.string().default(''),
  SMTP_PORT: z.coerce.number().int().positive().max(65535).default(587),
  SMTP_SECURE: booleanFromString.default('false'),
  SMTP_USER: z.string().default(''),
  SMTP_PASSWORD: z.string().default(''),
  NOTIFICATION_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(5),
  NOTIFICATION_BACKOFF_MS: z.coerce.number().int().positive().default(30_000),
  NOTIFICATION_TICK_MS: z.coerce.number().int().positive().default(5_000),
  NOTIFICATION_BATCH_SIZE: z.coerce.number().int().positive().max(500).default(50),

  // Retention windows for periodic pruning (Phase 11).
  CHECK_RESULT_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(90),
  REFRESH_TOKEN_RETENTION_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  NOTIFICATION_DELIVERY_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(180),

  // Scheduler. When enabled, a loop periodically enqueues due monitors.
  SCHEDULER_ENABLED: booleanFromString.default('false'),
  // How often the scheduler ticks (ms).
  SCHEDULER_TICK_MS: z.coerce.number().int().positive().default(5_000),
  // Max monitors claimed per tick (bounds enqueue burst).
  SCHEDULER_BATCH_SIZE: z.coerce.number().int().positive().max(1000).default(100),

  // Trust the X-Forwarded-* headers when running behind a reverse proxy.
  TRUST_PROXY: booleanFromString.default('false'),
});

/**
 * Parse and validate process.env. Exits the process with a clear message when
 * configuration is invalid, so misconfiguration fails fast at startup.
 * @returns {z.infer<typeof envSchema>}
 */
function loadEnv() {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    // Use stderr directly: the logger depends on validated config, so it may not be safe yet.
    process.stderr.write(`Invalid environment configuration:\n${issues}\n`);
    process.exit(1);
  }

  const env = result.data;

  // Production hardening: fail fast on insecure defaults.
  if (env.NODE_ENV === 'production') {
    const problems = [];
    if (env.DB_PASSWORD === '') {
      problems.push('  - DB_PASSWORD: must be set in production');
    }
    if (env.JWT_SECRET === 'dev-insecure-jwt-secret-change-me' || env.JWT_SECRET.length < 32) {
      problems.push('  - JWT_SECRET: must be set to a strong value (>= 32 chars) in production');
    }
    if (env.MONITOR_ALLOW_PRIVATE_TARGETS) {
      problems.push(
        '  - MONITOR_ALLOW_PRIVATE_TARGETS: must be false in production (SSRF protection)'
      );
    }
    if (env.NOTIFICATIONS_ENABLED && env.EMAIL_PROVIDER === 'smtp' && !env.SMTP_HOST) {
      problems.push('  - SMTP_HOST: required when NOTIFICATIONS_ENABLED and EMAIL_PROVIDER=smtp');
    }
    if (problems.length > 0) {
      process.stderr.write(`Invalid environment configuration:\n${problems.join('\n')}\n`);
      process.exit(1);
    }
  }

  return env;
}

const env = loadEnv();

/**
 * Parsed list of allowed CORS origins.
 * @returns {string[]}
 */
function corsOrigins() {
  return env.CORS_ORIGINS.split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}

module.exports = {
  env,
  corsOrigins,
  isProduction: env.NODE_ENV === 'production',
  isTest: env.NODE_ENV === 'test',
};
