'use strict';

const { env } = require('../../config/env');
const logger = require('../../utils/logger');

/**
 * Email provider abstraction.
 *
 * Contract: send({ to, subject, text, html? }) -> Promise<{ ok: true, providerResponse?: string }>.
 * The provider throws on transport-level failure; the dispatcher decides retry
 * vs give-up based on attempt count. The concrete provider is chosen by
 * EMAIL_PROVIDER at process start, but can be overridden via setProvider(...)
 * so tests can inject a mock without touching the file system or env.
 *
 * Log discipline: never log the full recipient address at info level or above;
 * providers must not include SMTP credentials or provider-side response bodies
 * in exceptions or logs.
 */

let overrideProvider = null;

/**
 * Log provider: records intent without sending. Default in dev/tests when no
 * SMTP is configured. Recipient is redacted in logs.
 */
const logProvider = {
  name: 'log',
  async send({ to, subject }) {
    const redacted = redactEmail(to);
    logger.info('Email (log-provider) would send', { to: redacted, subject });
    return { ok: true, providerResponse: 'logged' };
  },
};

/**
 * SMTP provider (nodemailer). Lazy-loaded so the dependency is only required
 * when EMAIL_PROVIDER=smtp; the log provider and mock providers work without it.
 */
function buildSmtpProvider() {
  let transporter = null;
  const getTransporter = () => {
    if (transporter) return transporter;
    // eslint-disable-next-line global-require
    const nodemailer = require('nodemailer');
    transporter = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE,
      auth:
        env.SMTP_USER && env.SMTP_PASSWORD
          ? { user: env.SMTP_USER, pass: env.SMTP_PASSWORD }
          : undefined,
    });
    return transporter;
  };

  return {
    name: 'smtp',
    async send({ to, subject, text, html }) {
      const info = await getTransporter().sendMail({
        from: env.EMAIL_FROM,
        to,
        subject,
        text,
        html,
      });
      // Return a short, non-sensitive identifier only.
      return { ok: true, providerResponse: info.messageId || 'sent' };
    },
  };
}

/**
 * Returns the active provider. Order of precedence:
 *   1. Any provider set via setProvider (used by tests).
 *   2. The provider selected by EMAIL_PROVIDER env var.
 * @returns {{ name: string, send: Function }}
 */
function getProvider() {
  if (overrideProvider) return overrideProvider;
  if (env.EMAIL_PROVIDER === 'smtp') return buildSmtpProvider();
  return logProvider;
}

/**
 * Test hook: swap in a mock provider (or pass null to clear).
 * @param {{ name?: string, send: Function }|null} provider
 */
function setProvider(provider) {
  overrideProvider = provider;
}

/**
 * Redacts a recipient email address to `x***@domain` for log output.
 * @param {string} email
 * @returns {string}
 */
function redactEmail(email) {
  if (!email || typeof email !== 'string') return '(unknown)';
  const at = email.indexOf('@');
  if (at <= 1) return '***';
  return `${email[0]}***@${email.slice(at + 1)}`;
}

module.exports = { getProvider, setProvider, redactEmail };
