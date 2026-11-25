'use strict';

const { ZodError } = require('zod');
const ApiError = require('../utils/ApiError');
const logger = require('../utils/logger');
const { isProduction } = require('../config/env');

/**
 * Normalizes an arbitrary thrown value into an ApiError.
 * @param {unknown} err
 * @returns {ApiError}
 */
function normalizeError(err) {
  if (err instanceof ApiError) {
    return err;
  }

  if (err instanceof ZodError) {
    return ApiError.badRequest('Validation failed', {
      code: 'VALIDATION_ERROR',
      details: err.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    });
  }

  // Unknown/unexpected error: do not leak internal details to clients.
  const message = err instanceof Error ? err.message : 'Unknown error';
  const apiError = ApiError.internal();
  apiError.cause = message;
  return apiError;
}

/**
 * Centralized error-handling middleware. Must be registered last.
 */
// eslint-disable-next-line no-unused-vars -- Express identifies error handlers by arity (4 args).
function errorHandler() {
  return function errorHandlerMiddleware(err, req, res, _next) {
    const apiError = normalizeError(err);

    const logMeta = {
      requestId: req.id,
      method: req.method,
      path: req.originalUrl,
      statusCode: apiError.statusCode,
      code: apiError.code,
    };

    if (apiError.statusCode >= 500) {
      logger.error(apiError.message, { ...logMeta, cause: apiError.cause, stack: err.stack });
    } else {
      logger.warn(apiError.message, logMeta);
    }

    const body = {
      error: {
        code: apiError.code,
        message: apiError.message,
        requestId: req.id,
      },
    };

    if (apiError.details !== undefined) {
      body.error.details = apiError.details;
    }

    // Only expose stack traces outside production.
    if (!isProduction && apiError.statusCode >= 500 && err.stack) {
      body.error.stack = err.stack;
    }

    res.status(apiError.statusCode).json(body);
  };
}

module.exports = errorHandler;
