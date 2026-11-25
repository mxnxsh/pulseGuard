'use strict';

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const { env, corsOrigins } = require('./config/env');
const requestId = require('./middleware/requestId');
const httpLogger = require('./middleware/httpLogger');
const notFound = require('./middleware/notFound');
const errorHandler = require('./middleware/errorHandler');
const healthRoutes = require('./modules/health/health.routes');
const authRoutes = require('./modules/auth/auth.routes');
const userRoutes = require('./modules/users/users.routes');
const organizationRoutes = require('./modules/organizations/organizations.routes');
const docsRoutes = require('./modules/docs/docs.routes');

/**
 * Builds and configures the Express application without starting a listener.
 * Keeping app creation separate from the server makes it testable via Supertest.
 * @returns {import('express').Express}
 */
function createApp() {
  const app = express();

  if (env.TRUST_PROXY) {
    app.set('trust proxy', 1);
  }
  app.disable('x-powered-by');

  // Request context and security headers first.
  app.use(requestId());
  app.use(helmet());

  // Explicit CORS: allow only configured origins. When none are configured,
  // cross-origin requests are rejected (same-origin still works).
  const allowedOrigins = corsOrigins();
  app.use(
    cors({
      origin(origin, callback) {
        // Non-browser or same-origin requests have no Origin header.
        if (!origin) {
          return callback(null, true);
        }
        if (allowedOrigins.includes(origin)) {
          return callback(null, true);
        }
        return callback(null, false);
      },
      credentials: true,
    })
  );

  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false, limit: '1mb' }));

  app.use(httpLogger());

  // Baseline rate limiting across the API.
  app.use(
    rateLimit({
      windowMs: env.RATE_LIMIT_WINDOW_MS,
      max: env.RATE_LIMIT_MAX,
      standardHeaders: true,
      legacyHeaders: false,
    })
  );

  // Routes.
  app.use('/api/v1/health', healthRoutes);
  app.use('/api/v1/auth', authRoutes);
  app.use('/api/v1/users', userRoutes);
  app.use('/api/v1/organizations', organizationRoutes);
  app.use('/api/v1', docsRoutes);

  // 404 + centralized error handling last.
  app.use(notFound());
  app.use(errorHandler());

  return app;
}

module.exports = { createApp };
