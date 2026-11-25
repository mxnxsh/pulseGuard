'use strict';

const logger = require('../utils/logger');

/**
 * Lightweight request logger. Logs method, path, status, duration, and request ID
 * on response finish. Avoids logging headers or bodies to prevent leaking secrets.
 */
function httpLogger() {
  return function httpLoggerMiddleware(req, res, next) {
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
      logger.http('request', {
        requestId: req.id,
        method: req.method,
        path: req.originalUrl,
        status: res.statusCode,
        durationMs: Math.round(durationMs * 100) / 100,
      });
    });
    next();
  };
}

module.exports = httpLogger;
