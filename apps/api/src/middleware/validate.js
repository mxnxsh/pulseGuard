'use strict';

const ApiError = require('../utils/ApiError');

/**
 * Returns middleware that validates and replaces req.body with the parsed result
 * of a Zod schema. Validation failures become a 400 VALIDATION_ERROR handled by
 * the centralized error handler.
 * @param {import('zod').ZodTypeAny} schema
 * @returns {import('express').RequestHandler}
 */
function validateBody(schema) {
  return function validateBodyMiddleware(req, _res, next) {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      return next(
        ApiError.badRequest('Validation failed', {
          code: 'VALIDATION_ERROR',
          details: result.error.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          })),
        })
      );
    }
    req.body = result.data;
    return next();
  };
}

module.exports = { validateBody };
