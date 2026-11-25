'use strict';

/**
 * Application error carrying an HTTP status code and a stable error code.
 * Thrown by services/controllers and translated to a JSON response by the
 * centralized error handler.
 */
class ApiError extends Error {
  /**
   * @param {number} statusCode HTTP status code.
   * @param {string} message Human-readable message safe for clients.
   * @param {object} [options]
   * @param {string} [options.code] Stable machine-readable error code.
   * @param {unknown} [options.details] Optional structured details (e.g. validation issues).
   */
  constructor(statusCode, message, { code, details } = {}) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.code = code || 'ERROR';
    this.details = details;
    this.isOperational = true;
    Error.captureStackTrace(this, this.constructor);
  }

  static badRequest(message, options) {
    return new ApiError(400, message, { code: 'BAD_REQUEST', ...options });
  }

  static unauthorized(message = 'Unauthorized', options) {
    return new ApiError(401, message, { code: 'UNAUTHORIZED', ...options });
  }

  static forbidden(message = 'Forbidden', options) {
    return new ApiError(403, message, { code: 'FORBIDDEN', ...options });
  }

  static notFound(message = 'Not found', options) {
    return new ApiError(404, message, { code: 'NOT_FOUND', ...options });
  }

  static internal(message = 'Internal server error', options) {
    return new ApiError(500, message, { code: 'INTERNAL_ERROR', ...options });
  }
}

module.exports = ApiError;
