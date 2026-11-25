'use strict';

const ApiError = require('../utils/ApiError');

/**
 * Terminal middleware for unmatched routes. Forwards a 404 ApiError to the
 * centralized error handler.
 */
function notFound() {
  return function notFoundMiddleware(req, _res, next) {
    next(ApiError.notFound(`Route not found: ${req.method} ${req.originalUrl}`));
  };
}

module.exports = notFound;
