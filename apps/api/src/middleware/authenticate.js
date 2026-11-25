'use strict';

const ApiError = require('../utils/ApiError');
const { verifyAccessToken } = require('../modules/auth/tokens');

/**
 * Requires a valid Bearer access token. On success attaches req.auth with the
 * authenticated user's internal id and public id. Rejects with 401 otherwise.
 * Does not leak the reason for token rejection to the client.
 */
function authenticate() {
  return function authenticateMiddleware(req, _res, next) {
    const header = req.headers.authorization || '';
    const [scheme, token] = header.split(' ');

    if (scheme !== 'Bearer' || !token) {
      return next(ApiError.unauthorized('Missing or malformed Authorization header'));
    }

    try {
      const payload = verifyAccessToken(token);
      req.auth = { userId: Number(payload.sub), publicId: payload.pid };
      return next();
    } catch (_error) {
      return next(ApiError.unauthorized('Invalid or expired access token'));
    }
  };
}

module.exports = authenticate;
