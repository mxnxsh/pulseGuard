'use strict';

const { randomUUID } = require('crypto');

/**
 * Attaches a request ID to each request and echoes it back via the
 * X-Request-Id response header. Reuses an incoming X-Request-Id when present.
 */
function requestId() {
  return function requestIdMiddleware(req, res, next) {
    const incoming = req.headers['x-request-id'];
    const id = typeof incoming === 'string' && incoming.trim() ? incoming.trim() : randomUUID();
    req.id = id;
    res.setHeader('X-Request-Id', id);
    next();
  };
}

module.exports = requestId;
